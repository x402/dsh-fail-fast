# dsh-fail-fast

<p align="center">
  <img alt="dsh-fail-fast icon" src="https://raw.githubusercontent.com/x402/dsh-fail-fast/main/docs/assets/icon.svg" width="96" height="96">
</p>

<p align="center">
  <a href="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-fail-fast"><img alt="npm" src="https://img.shields.io/npm/v/dsh-fail-fast"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

[中文](README.md) | **English**

A DeepSeek Harness (DSH) plugin that adds fail-fast behavior to tool calls within a
single step. Once any tool call fails, the plugin intercepts all remaining unstarted
calls and returns synthesized `is_error: true` ("not executed") results to the model.

Models frequently emit dependent tool calls in a single response (e.g., `write`
followed by `bash`). DSH's agent loop already handles execution order:
concurrency-safe reads share parallel groups, while other calls run sequentially in
their own ordering groups according to model output order. The missing piece is
failure handling — when an earlier call fails, DSH still dispatches subsequent calls
whose preconditions no longer hold, wasting execution and risking destructive side
effects.

Models naturally emit tool calls in dependency order, making the output sequence
itself an implicit dependency topology. Leveraging this property, the plugin leaves
DSH's concurrency and ordering schedule intact and requires no knowledge of tool
semantics or dependency graphs, simply halting unstarted calls after a failure point.
Because skipped calls return with an explicit "not executed" reason, the current
turn's context stays intact and the model can recover directly on the next turn.

## Features

- **Scheduling untouched** — the plugin takes over no scheduling: concurrency-safe
  calls still overlap up to `maxParallelToolCalls`, other calls keep their ordering
  groups, and dispatch is never degraded to global serial execution.
- **Stop at the first failure** — any final `is_error: true` result (tool error,
  policy denial, timeout, post-execute block) cancels every remaining unstarted call;
  siblings already started in the failing group finish normally.
- **Model-repairable result** — skipped calls come back as `is_error: true` with
  `FailFastSkippedError` / `SKIPPED_AFTER_FAILURE` and an `Error: Not executed: …`
  message, so the model can fix the failure and re-issue the remaining calls.
- **Non-invasive** — the plugin only observes public DSH extension points
  (`session/event`, `tools/result`, `tools/pre-execute`); it never replaces the tool
  executor or rewrites the failing call's own result, and a denied call runs no body
  and triggers no approval.
- **No dependencies, no config overrides** — a single dependency-free ESM Host plugin;
  `cordis.patch.yml` only inserts the plugin row and overrides nothing.
- **Scoped** — only model-direct top-level calls participate; PTC sub-calls (which
  carry `exec.parent`) and subagents (separate sessions) have independent state.
  Single-call batches and aborted batches are unaffected.

## How it works

DSH's agent loop already runs one step's calls as **ordering groups**, one group at a
time: a group is fully drained and committed in model order before the next starts.
On top of that the plugin does three things:

1. **Batch tracking** — listens to `session/event` (`step/start`, `tool/call`) and
   records the ordered call ids of the step in flight.
2. **Failure point** — listens to `tools/result` and pins the first `is_error: true`
   call in model order.
3. **Cancel the rest** — a prepended `tools/pre-execute` listener denies calls after
   the failure point that have not started. A denied call never runs its body and
   never triggers an approval, but the loop still records the normal `tool/call` +
   `tool/result` pair, so the model sees:

   ```text
   Error: Not executed: the preceding `read` call failed, so fail-fast skipped this call
   and every call that had not started yet in the batch. Fix the failure first, then
   re-issue the remaining calls in dependency order.
   ```

The failing call's own result is left untouched.

## Behavior and boundaries

- Any final `is_error: true` result counts as a failure: tool errors, policy denials,
  timeouts and post-execute blocks all cancel the rest of the batch.
- Calls already started in the failing group run to completion (they declared
  themselves concurrency-safe and independent, so their results remain meaningful); no
  new call starts afterwards. If the failure commits very quickly, a same-group tail
  that has not been prepared yet is also skipped; that is the conservative direction.
- Non-concurrency-safe calls (writes, bash, …) are single-call groups, so
  `write → bash` dependency order is preserved naturally.
- A single-call batch is unaffected; batch state resets at every step boundary.
- Aborted batches are synthesized by the agent loop itself (`aborted before
  dispatch`); this plugin stays out of that path.
- Cost: already-started same-group calls cannot be recalled (they are independent,
  which is what allows the overlap). Tools that want to stop earlier must honor
  `exec.signal`.

## Install

The plugin is published on npm as `dsh-fail-fast`. In the DSH Web **Plugins** page,
choose **Add plugin**, enter the package name, and click **Enable now** once it is
installed:

```text
dsh-fail-fast
```

Or install it from a session with the plugin manager tool (installs and enables it):

```text
plugin_manager(action: "install_bundle", target: "dsh-fail-fast")
```

DSH reports newer versions and updates the plugin in place.

### Other install paths

- **Pinned version / preview commit** — paste
  `https://github.com/x402/dsh-fail-fast#<tag-or-commit>` into the install field.
  GitHub installs need `git` and GitHub connectivity, and DSH does not check them for
  updates, so upgrading means uninstalling and installing again.
- **Local development** — clone the repository and install the checkout as a bundle
  (`link:` or an absolute path); see [AGENTS.md](AGENTS.md).

The `package.json` declares DSH compatibility `>=0.2.0-rc.2 <0.3.0`. Behind a slow
network, pick a custom registry mirror in the install dialog.

`plugin_manager` `list_plugins` / `list_bundles` confirm the `fail-fast` row is
enabled.

## Acknowledgements

The problem this plugin solves was originally identified by
[@Golden-Pigeon](https://github.com/Golden-Pigeon).

## License

[MIT](LICENSE) © 2026 x402 and the dsh-fail-fast contributors
