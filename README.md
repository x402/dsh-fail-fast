# dsh-fail-fast

<p align="center">
  <a href="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-fail-fast"><img alt="npm" src="https://img.shields.io/npm/v/dsh-fail-fast"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

**中文** | [English](README.en.md)

一个 DSH（DeepSeek Harness）插件：把「模型一次返回的多个工具调用」当作一个批次，实现**组内并行、组间顺序、失败即停** —— 并行安全的只读调用照常并发；一旦某个调用失败，所有**尚未开始**的调用不再执行，并为它们合成 `is_error: true` 的「未执行」结果返回给模型。

它要解决的是并行调用中的一个现实问题：模型经常一次发出有先后依赖的调用（例如先 `write` 再 `bash`），一旦前面的调用失败，后面调用的输入前提就已过期，继续执行既是纯浪费，也可能留下破坏性副作用；而把整个批次改成串行虽然安全，却白白牺牲了只读调用的并发度。

插件利用一个简单观察 —— 模型通常按依赖顺序发射调用，发射顺序本身就是天然的依赖拓扑 —— 只在失败点之后拒绝尚未开始的调用，因此不需要理解任何工具语义或依赖图。再加上被跳过的调用会带着明确的「未执行」原因回到模型，下一轮直接修复即可，这一轮 provider 请求也没有被浪费。

## 核心特性

- **组内并行**：声明了 `isConcurrencySafe` 的调用照常按 `maxParallelToolCalls` 并发执行，启用插件不会把调度降级为全局串行。
- **组间顺序**：有副作用或顺序依赖的调用（写文件、bash 等）各自单独成组，天然构成 barrier，`write → bash` 之类的依赖顺序保持不变。
- **失败即停**：任何最终 `is_error: true` 的结果（工具报错、策略拒绝、超时、post-execute block）都会中止本批次中所有尚未开始的调用；失败组内已启动的调用自然完成。
- **模型可直接修复**：被跳过的调用返回 `is_error: true`，携带 `FailFastSkippedError` / `SKIPPED_AFTER_FAILURE`，正文以 `Error: Not executed:` 开头，模型据此修复失败并重发剩余调用。
- **零侵入**：只观察 DSH 的公开扩展点（`session/event`、`tools/result`、`tools/pre-execute`），不替换工具执行器，也不改写失败调用自身的结果；被拒调用不执行函数体、不触发审批。
- **零依赖、零配置覆盖**：纯 ESM 单文件 Host 插件，无运行时依赖；`cordis.patch.yml` 只插入插件行，不覆盖任何既有配置。
- **作用域受限**：只作用于模型直接调用的顶层调用；PTC 子调用（带 `exec.parent`）和子代理（独立 session）各自独立；单调用批次与 abort 批次行为不变。

## 工作方式

DSH 的 agent loop 本来就把一个 step 的调用切成**顺序组**：并行安全调用组成并行组，其余调用各自单独成组，且一个组完整 drain 并按模型顺序提交后才会启动下一组。插件在此基础上做三件事：

1. **批次跟踪**：监听 `session/event` 的 `step/start`、`tool/call`，按模型发射顺序记录当前 step 的 callId。
2. **失败点**：监听 `tools/result`，把模型顺序中第一个 `is_error: true` 的下标记为失败点。
3. **取消后续**：在 `tools/pre-execute` 上 `prepend` 一个 listener，对失败点之后、尚未开始的调用直接 `deny`。被拒调用不执行函数体、不触发审批，但 loop 仍会正常写 `tool/call` + `tool/result` 事件对，模型看到：

   ```text
   Error: Not executed: the preceding `read` call failed, so fail-fast skipped this call
   and every call that had not started yet in the batch. Fix the failure first, then
   re-issue the remaining calls in dependency order.
   ```

失败本身沿用原始工具结果，不改写。

## 行为与边界

- 任何 `is_error: true` 的最终结果都算失败：工具报错、策略拒绝、超时、post-execute block 均会触发取消后续。
- 已启动的同组调用会自然完成（它们声明了并发安全、彼此独立，结果仍然有效）；失败后不会再有新调用开始。极端情况下，失败在组内提交得很快时，同组尾部尚未 prepare 的调用也会被跳过 —— 这是保守方向，符合 fail-fast。
- 非并发安全调用（写文件、bash 等）各自单独成组，所以 `write → bash` 这类依赖顺序天然保持。
- 单个调用的批次行为不变；一个 step 结束、下一个 step 开始时批次状态自动重置。
- 已取消（abort）的批次由 agent loop 自己合成「aborted before dispatch」结果，本插件不参与。
- 代价：失败时已经启动的同组调用无法收回（它们独立，这正是允许并行的前提）；如果希望失败后连已启动调用也强制中断，需要在工具实现里自行响应 `exec.signal`。

## 安装

本插件发布在 npm，包名为 `dsh-fail-fast`。在 DSH Web 的「插件」页点「添加插件」，输入包名安装，完成后点「立即启用」：

```text
dsh-fail-fast
```

也可以在会话里用插件管理工具安装（安装并启用）：

```text
plugin_manager(action: "install_bundle", target: "dsh-fail-fast")
```

DSH 会在有新版本时提示并支持一键更新。

### 其他安装方式

- **固定版本 / 预览提交**：在安装框粘贴 `https://github.com/x402/dsh-fail-fast#<tag 或 commit>`。GitHub 地址安装需要本机有 git 且能访问 GitHub；这种方式 DSH 不检查更新，升级需要先卸载再重装。
- **本地开发**：clone 仓库后把 checkout 作为 bundle 安装（`link:` 或绝对路径），见 [AGENTS.md](AGENTS.md)。

插件在 `package.json` 中声明兼容 DSH `>=0.2.0-rc.2 <0.3.0`。国内网络下可在安装对话框里选择自定义 registry 镜像。

已安装的 profile 可以用 `plugin_manager` 的 `list_plugins` / `list_bundles` 确认 `fail-fast` 已启用。

## 致谢

本插件要解决的问题最初由 [@Golden-Pigeon](https://github.com/Golden-Pigeon) 发现并指出。

## License

[MIT](LICENSE) © 2026 x402 and the dsh-fail-fast contributors
