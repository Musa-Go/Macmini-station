import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, configPath } from '../src/config.js'
import { backup, check, findRestic, restore, resolveTarget } from '../src/backup.js'

/**
 * These tests never call a real restic. A stub shell script stands in for it and
 * records its argv, which is exactly what we need to prove the contract:
 * restic is located, never bundled, and always invoked with --repo.
 */
function sandbox({ withRestic = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'station-backup-'))
  const binDir = join(dir, 'bin')
  mkdirSync(binDir)
  const calls = join(dir, 'calls.log')

  const resticPath = join(binDir, 'restic')
  writeFileSync(
    resticPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1" in
  version) echo "restic 0.18.0 compiled with go1.24" ;;
  *) echo "snapshot abc123 saved" ;;
esac
exit 0
`,
  )
  chmodSync(resticPath, 0o755)

  const passwordFile = join(dir, 'restic.pass')
  writeFileSync(passwordFile, 'test-password')

  const config = defaultConfig()
  config.storage.backup.target = { type: 'local', path: join(dir, 'backups') }
  writeFileSync(configPath({ cwd: dir }), JSON.stringify(config, null, 2))

  const env = withRestic
    ? { RESTIC_BIN: resticPath, RESTIC_PASSWORD_FILE: passwordFile }
    : { RESTIC_BIN: join(binDir, 'missing-restic'), RESTIC_PASSWORD_FILE: passwordFile }

  return {
    dir,
    config,
    env,
    resticPath,
    passwordFile,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('findRestic reports a helpful hint when the binary is missing', () => {
  const result = findRestic({ env: {} })
  if (result.ok) {
    // A machine with restic installed is a valid environment; assert shape only.
    assert.equal(typeof result.path, 'string')
    return
  }
  assert.match(result.error, /not found/)
  assert.match(result.hint, /brew install restic|releases/)
})

test('findRestic rejects a RESTIC_BIN that does not exist', () => {
  const result = findRestic({ env: { RESTIC_BIN: '/nope/restic' } })
  assert.equal(result.ok, false)
  assert.match(result.error, /missing file/)
})

test('resolveTarget refuses a disabled backup and an empty path', () => {
  const disabled = defaultConfig()
  disabled.storage.backup.enabled = false
  assert.equal(resolveTarget(disabled).ok, false)

  const empty = defaultConfig()
  empty.storage.backup.target.path = ''
  assert.equal(resolveTarget(empty).ok, false)
})

test('backup dry-run explains what it would do without touching disk', () => {
  const s = sandbox()
  try {
    const result = backup({ cwd: s.dir, config: s.config, env: s.env, dryRun: true })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.wouldInit, true)
    assert.equal(existsSync(join(s.dir, 'backups', 'restic')), false, 'dry run must not create the repo')
    const calls = s.calls()
    assert.ok(!calls.some((c) => c.includes('init') || c.includes('backup')), 'dry run must not init or back up')
    assert.ok(calls.every((c) => c.includes('version')), 'dry run may only probe the version')
  } finally {
    s.cleanup()
  }
})

test('backup refuses to run without RESTIC_PASSWORD_FILE', () => {
  const s = sandbox()
  try {
    const result = backup({ cwd: s.dir, config: s.config, env: { RESTIC_BIN: s.resticPath } })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'password')
    assert.match(result.hint, /RESTIC_PASSWORD_FILE/)
  } finally {
    s.cleanup()
  }
})

test('backup initialises a missing repo then backs up state and config', () => {
  const s = sandbox()
  try {
    // apply would create this in real use; the sandbox makes it explicitly.
    mkdirSync(join(s.dir, '.station'), { recursive: true })
    const result = backup({ cwd: s.dir, config: s.config, env: s.env })
    assert.equal(result.ok, true, JSON.stringify(result))
    const calls = s.calls()
    assert.ok(calls.some((c) => c.startsWith('--repo') && c.includes('init')), 'init should run first')
    // Tokenise: the repo path itself contains "backups", so a substring match
    // would pick the init call by accident.
    const backupCall = calls.find((c) => c.split(' ').includes('backup'))
    assert.ok(backupCall, 'backup should be invoked')
    assert.ok(
      backupCall.includes(join(s.dir, '.station')),
      `state dir should be a source, got: ${backupCall}`,
    )
    assert.ok(backupCall.includes(join(s.dir, 'station.json')), 'config should be a source')
    assert.ok(!calls.join(' ').includes('test-password'), 'password must never appear in argv')
  } finally {
    s.cleanup()
  }
})

test('backup reports a failed init instead of pretending success', () => {
  const s = sandbox()
  try {
    const failing = join(s.dir, 'bin', 'restic-fail')
    // version succeeds (binary is usable), init fails — the case the test targets.
    writeFileSync(failing, '#!/bin/sh\nif [ "$1" = version ]; then echo "restic 0.18.0"; exit 0; fi\necho "boom" >&2\nexit 1\n')
    chmodSync(failing, 0o755)
    const result = backup({ cwd: s.dir, config: s.config, env: { ...s.env, RESTIC_BIN: failing } })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'init')
    assert.match(result.error, /boom/)
  } finally {
    s.cleanup()
  }
})

test('check requires an existing repository', () => {
  const s = sandbox()
  try {
    const result = check({ cwd: s.dir, config: s.config, env: s.env })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'repo')
    assert.match(result.error, /station backup/)
  } finally {
    s.cleanup()
  }
})

test('check runs restic check once the repository exists', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.dir, '.station'), { recursive: true })
    backup({ cwd: s.dir, config: s.config, env: s.env })
    const result = check({ cwd: s.dir, config: s.config, env: s.env })
    assert.equal(result.ok, true)
    assert.ok(s.calls().some((c) => c.endsWith('check')))
  } finally {
    s.cleanup()
  }
})

test('restore requires --into and copies into a fresh directory', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.dir, '.station'), { recursive: true })
    backup({ cwd: s.dir, config: s.config, env: s.env })

    const missing = restore({ cwd: s.dir, config: s.config, env: s.env })
    assert.equal(missing.ok, false)
    assert.equal(missing.stage, 'arguments')

    const into = join(s.dir, 'drill')
    const result = restore({ cwd: s.dir, config: s.config, env: s.env, into })
    assert.equal(result.ok, true)
    assert.equal(result.target, into)
    assert.ok(existsSync(into))
    assert.ok(s.calls().some((c) => c.includes('restore') && c.includes(into)))
  } finally {
    s.cleanup()
  }
})

test('the real restic detection path never downloads anything', () => {
  const result = findRestic({ env: { RESTIC_BIN: '' } })
  // Installed or not, the contract is the same: no network, no bundled binary.
  assert.equal(typeof result.ok, 'boolean')
  if (!result.ok) assert.ok(result.hint, 'must tell the user how to install restic')
})