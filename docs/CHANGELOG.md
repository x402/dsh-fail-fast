# Changelog

All notable changes to this package are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- README (both languages) now documents only the plugin's features, behavior and
  install steps; development notes (verification log, version/interface tracking,
  repository layout, background research) were removed.

## [0.2.0] - 2026-10-26

### Changed

- Group-aware fail-fast: dropped the `agent-loop.maxParallelToolCalls: 1`
  override. DSH already runs one ordering group at a time, so the plugin now
  keeps the configured parallelism inside a group and only denies calls that
  have not started once a failure has committed. Parallel reads stay parallel.
- Skip notice now says "every call that had not started yet in the batch"
  instead of "every later call", matching the group semantics.

### Removed

- The `agent-loop` config override from `cordis.patch.yml`; the bundle patch now
  only inserts the plugin row.

## [0.1.0] - 2026-10-26

### Added

- Initial `dsh-fail-fast` bundle: tracks one model step's tool calls, remembers
  the first failed call, and denies the calls after it with a synthesized
  `FailFastSkippedError` / `SKIPPED_AFTER_FAILURE` result.
- Offline smoke tests over a mock Cordis context.
