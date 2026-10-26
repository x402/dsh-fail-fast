# dsh-fail-fast

<p align="center">
  <a href="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

**中文** | [English](README.en.md)

一个 DSH（DeepSeek Harness）插件：把「模型一次返回的多个工具调用」当作一个批次，**组内并行、组间顺序、失败即停** —— 并行安全的只读调用照常并发；一旦某个调用失败，所有**尚未开始**的调用（实际上就是后面的调度组）不再执行，并为它们合成 `is_error: true` 的「未执行」结果返回给模型。

## 关键洞察

模型的发射顺序就是天然的依赖拓扑：模型写 `[write, bash]` 时，几乎总是按依赖顺序排的。因此「失败点之后不再启动新调用」是安全近似 —— 插件不需要理解任何工具语义或依赖关系。

经济逻辑：首个调用失败后，后续调用的输入前提已经过期，继续执行是纯浪费，还可能产生破坏性副作用；跳过并把结果告诉模型，这一轮 provider 请求不浪费 —— 下一轮模型直接修复即可。

## 为什么不强制全局串行

DSH 的 agent loop 本来就把一个 step 的调用切成**顺序组（ordering groups）**：

- 声明了 `isConcurrencySafe` 的调用组成一个并行组，组内最多 `maxParallelToolCalls` 个同时执行；
- 其余调用（写文件、bash 等有副作用/有顺序依赖的工具）各自单独成组，天然构成 barrier；
- 关键点：**一个组会先完整 drain、并按模型顺序提交全部结果，然后才启动下一组**（rc.2 `runGroup` 的 settle/commit 循环，rc.3 `executeToolBatch` 同构）。

所以「组间」本来就是严格串行的，不需要把 `maxParallelToolCalls` 钉成 1。插件只做三件事：组内让并发跑满 → 组结束后看是否有失败 → 有失败就把后面的组全部取消。只读调用（read/grep/glob…）的并行度保留，而依赖链（`write` → `bash`）的 barrier 语义和失败即停也都在。

## 工作方式（只用一个 Host 插件）

1. **批次跟踪**：监听 `session/event` 的 `step/start`、`tool/call`，按模型发射顺序记录当前 step 的 callId（`tool/call` 由 loop 在 prepare 之前写入，组间顺序与模型顺序一致）。
2. **失败点**：监听 `tools/result`，把模型顺序中第一个 `isError: true` 的下标记为失败点（工具报错、策略拒绝、超时、post-execute block 都算）。
3. **取消后续**：在 `tools/pre-execute` 上 `prepend` 一个 listener，对失败点之后、尚未开始的调用直接返回 `deny`。被拒调用不执行函数体、也不会触发审批，但 loop 仍会正常写 `tool/call` + `tool/result` 事件对 —— 模型看到：

   ```text
   Error: Not executed: the preceding `read` call failed, so fail-fast skipped this call
   and every call that had not started yet in the batch. Fix the failure first, then
   re-issue the remaining calls in dependency order.
   ```

   失败本身沿用原始工具结果，不改写。只有「模型直接调用的顶层调用」参与（PTC 子调用带 `exec.parent`，不参与；子代理是独立 session，各自独立）。

`cordis.patch.yml` 只负责插入这个 Host 插件行，**不覆盖任何配置**。

## 仓库结构

| 路径 | 内容 |
|---|---|
| `src/index.js` | Host 插件本体（无运行时依赖，纯 ESM） |
| `cordis.patch.yml` | Bundle patch：只插入插件行 |
| `locale/en.json`, `locale/zh.json` | Plugin Manager 显示用的标题/描述 |
| `docs/assets/icon.svg` | 插件清单图标 |
| `docs/CHANGELOG.md` | 版本变更记录（Keep a Changelog） |
| `test/smoke.mjs` | mock ctx 的离线自测 |
| `AGENTS.md` | 给 AI 编码代理的仓库约束与开发流程 |

## 版本与接口

- 当前运行运行时是 **`0.2.1-rc.2`**：npm 的 `latest` tag 仍是 rc.2；`0.2.1-rc.3` 只在 npm 的 `next` tag 上（`npm install -g @deepseek-ai/dsh@next` 才能拿到，装完需要重启 `dsh web`）。
- 本插件用的三个扩展点（`session/event`、`tools/result`、`tools/pre-execute`）在 rc.3 源码中保持同名同语义，rc.3 的 `BatchSettlement` 同样在 `pipeline.prepare` 之前写 `tool/call`、并按组顺序提交 `tool/result`。因此升级到 rc.3 后插件不需要改代码。
- rc.3 新增的 `ToolExecutor` / `executeToolBatch` / `ctx.tools.setExecutor()` 是「整个批次执行器」级接口；对本策略不是必需的（那是替换整个调度器，而不是策略钩子），所以没有使用。
- 离线自测：`node test/smoke.mjs`（或 `npm test`），无依赖、不需要运行中的 harness。

## 安装

```bash
git clone https://github.com/x402/dsh-fail-fast.git ~/dsh/dsh-fail-fast
```

然后在 DSH 会话里把 checkout 作为 bundle 安装（绝对路径）：

```text
plugin_manager(action: "install_bundle", target: "/home/<you>/dsh/dsh-fail-fast")
```

已安装的 profile 可以用 `plugin_manager` 的 `list_plugins` / `list_bundles` 确认 `fail-fast` 已启用。修改源码后需要 remove + install 一次，或重启 harness，让新的 JS 模块代生效。

## 已验证（web profile，2026-10-26，组内并行版本）

用独立子代理会话跑真实批次，并解压持久化 session 事件核对：

**用例 1（核心）**：一批三个调用 `[read 不存在文件, read 已存在文件, bash 写文件]`，前两个是并发安全的读，属于同一并行组；bash 属于后面的组。

- `read 不存在文件`：失败（`FS_NOT_FOUND`）。
- `read 已存在文件`：**照常执行并成功**，结果里确认出现 `GROUP_READ_OK` —— 同组已启动的调用不被误伤，并行度保留。
- `bash 写文件`：结果为 `isError: true`、`error: {name: FailFastSkippedError, code: SKIPPED_AFTER_FAILURE}`，正文为 `Error: Not executed: …`；目标文件未被创建（body 未执行）。
- 持久化事件顺序也印证了组屏障：两个 read 的 `tool/result` 提交之后，bash 的 `tool/call` 才出现，随即被跳过。
- 同一会话的下一步（`send_message`）正常执行 —— step 变化后批次状态自动重置。

**用例 2（对照）**：一批 `[read 已存在文件 ×2, bash echo CONTROL_OK]` 全部执行成功，没有误判或误跳过。

**用例 3（回归）**：`[bash 成功, read 失败, bash 写文件]` 仍然表现为第 1 个执行、第 2 个失败、第 3 个跳过且目标文件未创建。

**配置侧**：`dsh --profile web --dump-config` 确认 `agent-loop` 配置中没有 `maxParallelToolCalls: 1`（保持默认并发上限），`fail-fast` 行正常插入。

## 行为与边界

- 任何 `isError: true` 的最终结果都算失败：工具报错、策略拒绝、超时、post-execute block 均会触发取消后续。
- 已启动的同组调用会自然完成（它们声明了并发安全、彼此独立，结果仍然有效）；失败后不会再有新调用开始。极端情况下，失败在组内提交得很快时，同组尾部尚未 prepare 的调用也会被跳过 —— 这是保守方向，符合 fail-fast。
- 非并发安全调用（写文件、bash 等）各自单独成组，所以 `write → bash` 这类依赖顺序天然保持。
- 单个调用的批次行为不变；一个 step 结束、下一个 step 开始时批次状态自动重置。
- 已取消（abort）的批次由 agent loop 自己合成「aborted before dispatch」结果，本插件不参与。
- 代价：失败时已经启动的同组调用无法收回（它们独立，这正是允许并行的前提）；如果希望失败后连已启动调用也强制中断，需要在工具实现里自行响应 `exec.signal`。

## 需求来源（Anthropic 文档对照）

- [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)：API 不规定执行顺序；独立只读操作可以并行，有副作用或顺序依赖的调用应当顺序执行。
- 同一页明确指出：computer use / browser use 工具要求「run them sequentially in the order they appear and stop at the first failure」，并给出了跳过调用的返回示例 `Not executed: the preceding write_file call failed.`（`is_error: true`）—— 本插件的合成结果与该官方模式一致。

## License

[MIT](LICENSE) © 2026 x402 and the dsh-fail-fast contributors
