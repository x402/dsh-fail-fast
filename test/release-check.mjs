// Offline tests for the release guard (scripts/check-release.mjs).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  changelogSection,
  checkChangelog,
  checkTag,
  readVersion,
  releaseTag,
} from '../scripts/check-release.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-release.mjs')

const sample = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.2.3] - 2026-01-02',
  '',
  '### Added',
  '',
  '- Thing.',
  '',
  '## [1.2.2] - 2025-12-31',
  '',
  '- Older.',
].join('\n')

const emptySection = ['## [1.2.3] - 2026-01-02', '', '## [1.2.2] - 2025-12-31', '', '- Older.'].join('\n')

let failures = 0
function check(label, run) {
  try {
    run()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label} :: ${error.message}`)
  }
}

function expectThrow(run, pattern) {
  assert.throws(run, pattern)
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

check('releaseTag prefixes v', () => {
  assert.equal(releaseTag('0.2.0'), 'v0.2.0')
})

check('readVersion returns the package release version', () => {
  const version = readVersion()
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.equal(releaseTag(version), `v${version}`)
})

check('changelogSection extracts the version body only', () => {
  const body = changelogSection(sample, '1.2.3')
  assert.match(body, /### Added\n\n- Thing\./)
  assert.doesNotMatch(body, /Older\./)
})

check('changelogSection returns null for a missing version', () => {
  assert.equal(changelogSection(sample, '9.9.9'), null)
})

check('checkChangelog rejects a missing version section', () => {
  expectThrow(() => checkChangelog('9.9.9', sample), /no "## \[9\.9\.9\]" section/)
})

check('checkChangelog rejects an empty version section', () => {
  expectThrow(() => checkChangelog('1.2.3', emptySection), /has no entries/)
})

check('checkTag accepts v<version>', () => {
  assert.equal(checkTag('v1.2.3', '1.2.3'), 'v1.2.3')
})

check('checkTag rejects a tag without the v prefix', () => {
  expectThrow(() => checkTag('1.2.3', '1.2.3'), /does not match package\.json/)
})

check('checkTag rejects a tag for another version', () => {
  expectThrow(() => checkTag('v1.2.4', '1.2.3'), /does not match package\.json/)
})

check('CLI passes with the repository tag and offline flags', () => {
  const version = readVersion()
  const result = runCli(['--tag', releaseTag(version), '--skip-registry', '--skip-tests'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /release check passed/)
})

check('CLI fails on a mismatched tag', () => {
  const result = runCli(['--tag', 'v0.0.0', '--skip-registry', '--skip-tests'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /does not match package\.json/)
})

check('CLI prints release notes for the current version', () => {
  const result = runCli(['--notes'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^### /m)
})

console.log(failures === 0 ? '\nall release guard checks passed' : `\n${failures} release guard check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
