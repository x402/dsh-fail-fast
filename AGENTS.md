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
| `scripts/check-release.mjs` | Release guard shared by `prepublishOnly` and the release workflow: tag vs `package.json`, CHANGELOG section, unpublished version, syntax check and tests. |
| `.github/workflows/ci.yml`, `release.yml` | CI (`check` + tests) and the tag-driven npm release. |

## Development

```bash
npm run check   # syntax check (plugin + release guard)
npm test        # offline tests (smoke + release guard), no DSH process needed
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

Releases are tag-driven; CI publishes. Bump `version` in `package.json`, add a
`docs/CHANGELOG.md` entry, commit and push `main`, then push the matching tag:

```bash
npm run check && npm test
git tag v<version> && git push origin v<version>
```

Pushing the tag runs `.github/workflows/release.yml`, which verifies that the tag
is `v<version>`, that the CHANGELOG has an entry for it, that the version is not
already on npm, and that the tests pass. It then publishes with
`npm publish --access public` through npm's OIDC trusted publishing (no
`NPM_TOKEN` in the repository; provenance is generated automatically) and
creates the GitHub Release from the CHANGELOG section. To retry a release, run
the workflow manually (Actions → Release → Run workflow) with the version; an
already-published version is not published twice.

One-time setup on npmjs.com: package → Settings → Publishing access → Trusted
publishers → GitHub Actions, with repository `x402/dsh-fail-fast`, workflow
filename `release.yml` (filename only), no environment, and direct `npm publish`
allowed under "Allowed actions" — new connections default to staged publishes
only. The connection must complete its first publish within two days or it
expires, so set it up when a release is ready. Without it the publish step fails
with an authentication error.

A manual `pnpm publish` (CI unavailable) remains possible; `prepublishOnly` runs
the same guard before the package leaves the machine.

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
5. **Every behavior change has an assertion** in the test suite
   (`test/smoke.mjs` for the plugin, `test/release-check.mjs` for the release
   guard). Do not weaken a test to make a change pass.
6. **No AI attribution.** Commit messages, PRs and comments use the
   contributor's own identity; no `Co-authored-by:` agent/model lines and no
   "Generated with …" footers.
7. **Do not commit generated output, credentials, or local scratch trees**
   (see `.gitignore`).

## License

MIT. See [LICENSE](LICENSE).
