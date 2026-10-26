# dsh-fail-fast

<p align="center">
  <a href="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/x402/dsh-fail-fast/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/dsh-fail-fast"><img alt="npm" src="https://img.shields.io/npm/v/dsh-fail-fast"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

[中文](README.md) | **English**

A DeepSeek Harness (DSH) plugin that treats the tool calls of one model response as
one batch and makes it **overlap within a scheduling group, run groups in order, and
stop at the first failure**: concurrency-safe read-only calls still run in parallel,
but once a call fails, every call that has not started yet is skipped and returned to
the model as an `is_error: true` "not executed" result.

It solves a real problem with parallel tool use: models often emit calls that depend
on one another (a `write` followed by a `bash`), and once an earlier call fails, the
later calls have lost their premise — running them is wasted work and can leave
destructive side effects, while making the whole batch serial would be safe but would
throw away the concurrency of read-only calls.

The plugin exploits a simple observation — models generally emit calls in dependency
order, so that order is already the dependency topology — and only denies calls that
have not started after the failure point, without understanding any tool's semantics
or a dependency graph. And because skipped calls come back with an explicit "not
executed" reason, the next turn repairs the batch and the current provider request is
not wasted.

## Features

- **Parallelism preserved** — calls that declare `isConcurrencySafe` still overlap up
  to `maxParallelToolCalls`; enabling the plugin never degrades dispatch to global
  serial execution.
- **Group order preserved** — side-effecting or order-dependent calls (file writes,
  bash, …) form exclusive single-call groups and therefore barriers, so `write → bash`
  dependency order is kept.
- **Stop at the first failure** — any final `is_error: true` result (tool error,
  policy denial, timeout, post-execute block) cancels every call in the batch that has
  not started yet; siblings already started in the failing group finish normally.
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

DSH's agent loop already partitions one step's calls into **ordering groups**:
concurrency-safe calls share a parallel group, every other call is its own group, and
a group is fully drained and committed in model order before the next group starts.
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
  that has not been prepared yet is also skipped — the conservative direction.
- Non-concurrency-safe calls (writes, bash, …) are single-call groups, so
  `write → bash` dependency order is preserved naturally.
- A single-call batch is unaffected; batch state resets at every step boundary.
- Aborted batches are synthesized by the agent loop itself (`aborted before
  dispatch`); this plugin stays out of that path.
- Cost: already-started same-group calls cannot be recalled (they are independent —
  that is what allows the overlap). Tools that want to stop earlier must honor
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

The problem this plugin solves was originally identified by @Golden-Pigeon (goldpig).

## License

[MIT](LICENSE) © 2026 x402 and the dsh-fail-fast contributors
