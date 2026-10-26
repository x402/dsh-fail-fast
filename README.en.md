# dsh-fail-fast

<p align="center">
  <a href="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

[中文](README.md) | **English**

A DeepSeek Harness (DSH) plugin that treats the tool calls of one model response as
one batch and makes it **fail fast across scheduling groups**: concurrency-safe
calls still overlap inside their group, but once a call fails, every call that has
not started yet is skipped and returned to the model as an `is_error: true`
"not executed" result.

## Key insight

The model's emission order is the dependency topology: when it writes
`[write, bash]`, it has almost certainly ordered the calls by dependency already.
"Start nothing after the failure point" is therefore a safe approximation — the
plugin never has to understand tool semantics or dependency graphs.

The economics are simple: after the first failure, the inputs of later calls are
stale. Continuing is pure waste and can be destructive. Skipping them and telling
the model does not waste the turn — the next turn repairs the batch.

## Why global serial dispatch is unnecessary

DSH's agent loop already partitions one step's calls into **ordering groups**:

- calls that declare `isConcurrencySafe` form one parallel group, overlapping up
  to `maxParallelToolCalls`;
- every other call (file writes, bash, anything with side effects or ordering
  requirements) is an exclusive single-call group and therefore a barrier;
- crucially, **a group is fully drained and committed in model order before the
  next group starts** (rc.2's `runGroup` settle/commit loop; rc.3's
  `executeToolBatch` has the same shape).

So groups are already strictly serial; pinning `maxParallelToolCalls` to 1 only
throws away parallel reads. The plugin does three things: let a group run at its
configured concurrency, inspect the group's outcome after it drains, and cancel
every later group on the first failure.

## How it works (one Host plugin, no dependencies)

1. **Batch tracking** — listens to `session/event` (`step/start`, `tool/call`) and
   records the ordered call ids of the step in flight. The loop appends `tool/call`
   before `prepare`, and group start order is model order.
2. **Failure point** — listens to `tools/result` and pins the first
   `isError: true` call in model order. Tool errors, policy denials, timeouts and
   post-execute blocks all count.
3. **Cancel the rest** — a prepended `tools/pre-execute` listener denies calls
   after the failure point that have not started. A denied call never runs its
   body and never triggers an approval, but the loop still records the normal
   `tool/call` + `tool/result` pair, so the model sees:

   ```text
   Error: Not executed: the preceding `read` call failed, so fail-fast skipped this call
   and every call that had not started yet in the batch. Fix the failure first, then
   re-issue the remaining calls in dependency order.
   ```

   The failing call's own result is left untouched. Only model-direct calls take
   part: PTC sub-dispatches carry `exec.parent`, and subagents are separate
   sessions with their own batch state.

`cordis.patch.yml` only inserts the Host row; it does not override any config.

## Repository layout

| Path | Contents |
|---|---|
| `src/index.js` | The Host plugin (dependency-free ESM) |
| `cordis.patch.yml` | Bundle patch: inserts the plugin row only |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title/description |
| `docs/assets/icon.svg` | Bundle icon |
| `docs/CHANGELOG.md` | Keep a Changelog release notes |
| `test/smoke.mjs` | Offline smoke tests over a mock Cordis context |
| `AGENTS.md` | Repository rules and workflow for AI coding agents |

## Version and interfaces

- The current runtime is **`0.2.1-rc.2`**: npm's `latest` tag still points at rc.2;
  `0.2.1-rc.3` is only on the `next` tag (`npm install -g @deepseek-ai/dsh@next`,
  then restart `dsh web`).
- The three extension points used here (`session/event`, `tools/result`,
  `tools/pre-execute`) keep the same names and semantics in rc.3; its
  `BatchSettlement` also appends `tool/call` before `pipeline.prepare` and commits
  `tool/result` per group. The plugin therefore needs no code change after the
  upgrade.
- rc.3's new `ToolExecutor` / `executeToolBatch` / `ctx.tools.setExecutor()` is a
  whole-batch-executor seam. It is not required for this policy — using it would
  replace the scheduler instead of adding a policy hook.
- Offline tests: `node test/smoke.mjs` (or `npm test`); no dependencies and no
  running harness required.

## Install

```bash
git clone https://github.com/x402/dsh-fail-fast.git ~/dsh/dsh-fail-fast
```

Then install the checkout as a bundle in a DSH session (absolute path):

```text
plugin_manager(action: "install_bundle", target: "/home/<you>/dsh/dsh-fail-fast")
```

`plugin_manager` `list_plugins` / `list_bundles` confirm the `fail-fast` row is
enabled. After editing the source, remove + install the bundle once (or restart
the harness) so a fresh JS module generation is loaded.

## Verified (web profile, 2026-10-26, group-aware version)

Real subagent sessions, cross-checked against the durable Session events:

**Case 1 (core)** — one batch `[read missing file, read existing file, bash write file]`;
the two reads are concurrency-safe and share a parallel group, bash is a later group.

- `read missing file` failed (`FS_NOT_FOUND`);
- `read existing file` **still ran and succeeded**, returning `GROUP_READ_OK` — the
  started sibling in the same group was not collateral damage;
- `bash write file` returned `isError: true` with
  `error: {name: FailFastSkippedError, code: SKIPPED_AFTER_FAILURE}` and the target
  file was never created;
- durable event order confirms the group barrier: both read results were committed
  before bash's `tool/call` appeared, and that call was denied immediately;
- the next step in the same session ran normally — batch state resets per step.

**Case 2 (control)** — `[read existing ×2, bash echo CONTROL_OK]`: everything ran,
nothing was skipped.

**Case 3 (regression)** — `[bash ok, read missing, bash write file]`: first ran,
second failed, third skipped with no file created.

**Config** — `dsh --profile web --dump-config` shows no
`maxParallelToolCalls: 1` override on `agent-loop`; the `fail-fast` row is inserted.

## Behavior and boundaries

- Any final `isError: true` result counts as a failure: tool errors, policy denials,
  timeouts and post-execute blocks all cancel the rest of the batch.
- Calls already started in the failing group run to completion. They declared
  themselves concurrency-safe and independent, so their results remain meaningful.
  If the failure commits while a same-group tail has not been prepared yet, that
  tail is also skipped — the conservative direction.
- Non-concurrency-safe calls (writes, bash, …) are single-call groups, so
  `write → bash` dependency order is preserved naturally.
- A single-call batch is unaffected; batch state resets at every step boundary.
- Aborted batches are synthesized by the agent loop itself (`aborted before
  dispatch`); this plugin stays out of that path.
- Cost: already-started same-group calls cannot be recalled (they are independent —
  that is what allows the overlap). Tools that want to stop earlier must honor
  `exec.signal`.

## Background (Anthropic docs)

- [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use):
  the API does not prescribe execution order; independent read-only calls may run
  concurrently, while side-effecting or order-dependent calls should run
  sequentially.
- The same page states that the computer-use / browser-use tools must
  "run them sequentially in the order they appear and stop at the first failure",
  and shows a skipped result `Not executed: the preceding write_file call failed.`
  with `is_error: true` — this plugin's synthesized result follows that pattern.

## License

[MIT](LICENSE) © 2026 x402 and the dsh-fail-fast contributors
