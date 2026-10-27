#!/usr/bin/env node
// Release preflight for dsh-fail-fast. Dependency-free ESM, like the plugin.
//
// Two callers share this one guard:
//   * `prepublishOnly` — every publish, including a manual emergency one
//   * `.github/workflows/release.yml` — the tag-driven release, with --tag
//
// Usage:
//   node scripts/check-release.mjs                 # guard a local publish
//   node scripts/check-release.mjs --tag v0.3.0    # also require tag == v<version>
//   node scripts/check-release.mjs --notes         # print the version's CHANGELOG section
//   node scripts/check-release.mjs --skip-registry --skip-tests   # offline tests

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG_PATH = join(ROOT, 'docs', 'CHANGELOG.md')

export const PACKAGE_NAME = 'dsh-fail-fast'

export function releaseTag(version) {
  return `v${version}`
}

export function readVersion(root = ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? '')) {
    throw new Error(`package.json version is not a release version: ${JSON.stringify(pkg.version)}`)
  }
  return pkg.version
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Body of the `## [version] - YYYY-MM-DD` section, or null when it is missing.
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index])) { end = index; break }
  }
  return lines.slice(start + 1, end).join('\n').trim()
}

export function checkChangelog(version, changelog = readFileSync(CHANGELOG_PATH, 'utf8')) {
  const body = changelogSection(changelog, version)
  if (body === null) {
    throw new Error(`docs/CHANGELOG.md has no "## [${version}]" section`)
  }
  if (!/^[-*] /m.test(body)) {
    throw new Error(`docs/CHANGELOG.md "## [${version}]" section has no entries`)
  }
  return body
}

export function checkTag(tag, version) {
  const expected = releaseTag(version)
  if (tag !== expected) {
    throw new Error(`release tag ${JSON.stringify(tag)} does not match package.json: expected ${expected}`)
  }
  return tag
}

export function publishedVersionExists(version, name = PACKAGE_NAME) {
  const spec = `${name}@${version}`
  try {
    execFileSync('npm', ['view', spec, 'version', '--json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim()
    // Confirmed absence; anything else means the registry could not be checked.
    if (/E404|404 Not Found|not in this registry/i.test(stderr)) return false
    throw new Error(`could not query the npm registry for ${spec}: ${stderr || error.message}`)
  }
}

function parseArgs(argv) {
  const options = { tag: null, notes: false, skipRegistry: false, skipTests: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--tag') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error('--tag needs a tag name, e.g. --tag v0.3.0')
      options.tag = value
      index += 1
    } else if (arg === '--notes') options.notes = true
    else if (arg === '--skip-registry') options.skipRegistry = true
    else if (arg === '--skip-tests') options.skipTests = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function runScript(script) {
  execFileSync('npm', ['run', script], { cwd: ROOT, stdio: 'inherit' })
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const version = readVersion()

  // No entry, no release: also refuses to print notes for an undocumented version.
  const section = checkChangelog(version)
  if (options.notes) {
    process.stdout.write(`${section}\n`)
    return
  }

  console.log(`version:   ${version}`)
  if (options.tag === null) {
    console.error('note: no --tag given, skipping the tag/version check (local publish)')
  } else {
    checkTag(options.tag, version)
    console.log(`tag:       ${options.tag} matches package.json`)
  }
  console.log(`changelog: entry found for ${version}`)

  if (options.skipRegistry) {
    console.error('note: --skip-registry given, not querying npm')
  } else if (publishedVersionExists(version)) {
    throw new Error(`${PACKAGE_NAME}@${version} is already published; bump the version first`)
  } else {
    console.log(`registry:  ${PACKAGE_NAME}@${version} is not published yet`)
  }

  if (options.skipTests) {
    console.error('note: --skip-tests given, not running check/tests')
  } else {
    runScript('check')
    runScript('test')
    console.log('tests:     check and offline tests passed')
  }

  console.log('release check passed')
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`release check failed: ${error.message}`)
    process.exitCode = 1
  }
}
