# AGENTS.md

Instructions for AI coding agents working in this repository. Humans: start with
[README.md](README.md) (English: [README.en.md](README.en.md)).

## What this is

`dsh-fail-fast` is a DeepSeek Harness (DSH) bundle: a single dependency-free Host
plugin plus a Loader patch that inserts it. It makes one model turn's tool batch
fail fast — inside a scheduling group, parallel-safe calls still overlap; once a
call fails, every call that has not started yet is denied and settled as an
`is_error` "not executed" result instead of running.

The plugin observes the public DSH extension points and never replaces the tool
executor:

- `session/event` (`step/start`, `tool/call`) — ordered call ids of the step in flight;
- `tools/result` — first failed call in model order;
- `tools/pre-execute` (`prepend`) — deny calls after the failure point.

## Layout

| Path | Contents |
| --- | --- |
| `src/index.js` | The whole Host plugin. Keep it one dependency-free ESM file until it genuinely needs splitting. |
| `cordis.patch.yml` | Bundle patch. It only inserts the `fail-fast` row; it must not override other rows' config. |
| `locale/en.json`, `locale/zh.json` | Plugin Manager title/description, exported through `package.json`. |
| `docs/assets/icon.svg` | Bundle icon (`icon` field and `./icon` export). |
| `docs/CHANGELOG.md` | Keep a Changelog format; add an entry for every user-visible change. |
| `test/smoke.mjs` | Mock-context tests for batch tracking, skipping, same-step reset and nested-call exclusion. |

## Development

```bash
npm run check   # node --check src/index.js
npm test        # offline smoke tests, no DSH process needed
```

Install / reinstall in a DSH profile. The published package installs by name from
the npm registry; a local checkout installs with `link:` or an absolute path. The
row is loaded by the Loader, so a replaced package needs remove + install, or a
harness restart, to load fresh JS:

```text
plugin_manager(action: "remove_bundle",  target: "dsh-fail-fast")
plugin_manager(action: "install_bundle", target: "dsh-fail-fast")            # npm
plugin_manager(action: "install_bundle", target: "<absolute checkout path>") # local dev
```

To verify live behavior, spawn a subagent instructed to issue one batch with a
failing read followed by a call that would leave a file behind, then check the
durable session events: the later call must be `isError: true` with
`error.code === "SKIPPED_AFTER_FAILURE"` and the file must not exist.

## Release

Bump `version` in `package.json`, add a `docs/CHANGELOG.md` entry, commit and
push `main`, then publish and tag:

```bash
npm run check && npm test
pnpm publish --access public --publish-branch main   # npm login; add --otp when 2FA asks
git tag v<version> && git push origin v<version>
```

## Hard rules

1. **No runtime dependencies.** The plugin is plain ESM and imports nothing; it
   must load from a profile `link:` install without a package install step.
2. **Do not reintroduce global serial dispatch.** DSH already runs one ordering
   group at a time; forcing `agent-loop.maxParallelToolCalls: 1` throws away
   parallel reads. If the group-barrier assumption ever needs revisiting, change
   the plugin's docs and tests together.
3. **Conservative failure detection.** Any final `isError: true` result counts
   as a failure: tool errors, policy denials, timeouts, and post-execute blocks.
   Do not narrow this to thrown errors.
4. **Keep the model-facing contract.** Skipped calls stay `isError: true`, carry
   `FailFastSkippedError` / `SKIPPED_AFTER_FAILURE`, and their text starts with
   `Not executed:`. The model relies on this to repair the batch.
5. **Every behavior change has an assertion** in `test/smoke.mjs`. Do not weaken
   a test to make a change pass.
6. **No AI attribution.** Commit messages, PRs and comments use the
   contributor's own identity; no `Co-authored-by:` agent/model lines and no
   "Generated with …" footers.
7. **Do not commit generated output, credentials, or local scratch trees**
   (see `.gitignore`).

## License

MIT. See [LICENSE](LICENSE).
