# dsh-fail-fast

<p align="center">
  <img alt="dsh-fail-fast icon" src="https://raw.githubusercontent.com/x402/dsh-fail-fast/main/docs/assets/icon.svg" width="96" height="96">
</p>

<p align="center">
  <a href="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-fail-fast"><img alt="npm" src="https://img.shields.io/npm/v/dsh-fail-fast"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

**中文** | [English](README.en.md)

这是一个 DSH（DeepSeek Harness）插件，用于为同一 step 内的多工具调用增加“失败即停”（fail-fast）机制。一旦某个工具调用执行失败，插件会拦截后续尚未开始的调用，直接为它们合成 `is_error: true` 的“未执行”结果并返回给模型。

模型经常在一次响应中发出有先后依赖的调用（例如先 `write` 再 `bash`）。DSH 的 agent loop 本身已解决了执行顺序问题：并发安全的只读调用共享并行组并发执行，其余调用各自独占顺序组、按模型输出的顺序串行执行。真正的缺口在于失败处理——前置调用失败后，DSH 仍会继续派发后续调用。此时后续调用依赖的前提已经失效，继续执行既造成无谓消耗，又可能产生破坏性副作用。

模型通常按依赖关系依次输出调用，输出顺序本身就是天然的依赖拓扑。插件利用这一规律，保持原有的并发与串行调度策略不变，无需解析工具语义或构建依赖图，仅在失败点之后拦截未开始的调用。被跳过的调用会携带明确的“未执行”原因返回给模型，保留本轮请求的有效上下文，供模型在下一轮直接修复。

## 核心特性

- **调度不变**：插件不接管 DSH 的分组调度；并行组照常并发，顺序组照常串行（`write → bash` 这类依赖顺序天然保持），也不会把调度降级为全局串行。
- **失败即停**：任何最终 `is_error: true` 的结果（工具报错、策略拒绝、超时、post-execute block）都会中止本批次中所有尚未开始的调用。失败组内已启动的调用会自然完成。
- **模型可直接修复**：被跳过的调用返回 `is_error: true`，携带 `FailFastSkippedError` / `SKIPPED_AFTER_FAILURE`，正文以 `Error: Not executed:` 开头，模型据此修复失败并重发剩余调用。
- **零侵入**：只观察 DSH 的公开扩展点（`session/event`、`tools/result`、`tools/pre-execute`），不替换工具执行器，也不改写失败调用自身的结果；被拒调用不执行函数体、不触发审批。
- **零依赖、零配置覆盖**：纯 ESM 单文件 Host 插件，无运行时依赖；`cordis.patch.yml` 只插入插件行，不覆盖任何既有配置。
- **作用域受限**：只作用于模型直接调用的顶层调用；PTC 子调用（带 `exec.parent`）和子代理（独立 session）各自独立；单调用批次与 abort 批次行为不变。

## 工作方式

DSH 的 agent loop 已经按**顺序组**逐个执行一个 step 的调用：一组完整 drain、按模型顺序提交后才会启动下一组。插件在此基础上做三件事：

1. **批次跟踪**：监听 `session/event` 的 `step/start`、`tool/call`，按模型输出顺序记录当前 step 的 callId。
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
- 已启动的同组调用会自然完成（它们声明了并发安全、彼此独立，结果仍然有效）；失败后不会再有新调用开始。极端情况下，失败在组内提交得很快时，同组尾部尚未 prepare 的调用也会被跳过；这是保守方向，符合 fail-fast。
- 非并发安全调用（写文件、bash 等）各自单独成组，所以 `write → bash` 这类依赖顺序天然保持。
- 单个调用的批次行为不变；一个 step 结束、下一个 step 开始时批次状态自动重置。
- 已取消（abort）的批次由 agent loop 自己合成“aborted before dispatch”结果，本插件不参与。
- 代价：失败时已经启动的同组调用无法收回（它们独立，这正是允许并行的前提）；如果希望失败后连已启动调用也强制中断，需要在工具实现里自行响应 `exec.signal`。

## 安装

本插件发布在 npm，包名为 `dsh-fail-fast`。在 DSH Web 的“插件”页点“添加插件”，输入包名安装，完成后点“立即启用”：

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
