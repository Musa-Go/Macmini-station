import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig, writeDefaultConfig, loadConfig, configPath } from '../src/config.js'
import { validateConfig } from '../src/schema.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'station-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('default config is valid', () => {
  assert.deepEqual(validateConfig(defaultConfig()), [])
})

test('init writes station.json and is idempotent', () => {
  const { dir, cleanup } = tempDir()
  try {
    const first = writeDefaultConfig({ cwd: dir })
    assert.equal(first.created, true)
    const second = writeDefaultConfig({ cwd: dir })
    assert.equal(second.created, false)
    assert.equal(second.existing, true)
    const loaded = loadConfig({ cwd: dir })
    assert.equal(loaded.schemaVersion, 1)
    assert.equal(loaded.__meta.present, true)
  } finally {
    cleanup()
  }
})

test('loadConfig falls back to defaults when file is absent', () => {
  const { dir, cleanup } = tempDir()
  try {
    const config = loadConfig({ cwd: dir })
    assert.equal(config.__meta.present, false)
    assert.equal(config.machine.profile, 'macos-apple-silicon')
  } finally {
    cleanup()
  }
})

test('invalid json is rejected with a useful message', () => {
  const { dir, cleanup } = tempDir()
  try {
    writeFileSync(configPath({ cwd: dir }), '{ nope }')
    assert.throws(() => loadConfig({ cwd: dir }), /not valid JSON/)
  } finally {
    cleanup()
  }
})

test('schema rejects bad enums and missing required fields', () => {
  const bad = defaultConfig()
  bad.storage.backup.target.type = 'floppy'
  const problems = validateConfig(bad)
  assert.ok(problems.some((p) => p.path === 'storage.backup.target.type'))

  const missing = defaultConfig()
  delete missing.machine
  assert.ok(validateConfig(missing).some((p) => p.path === 'machine'))
})

test('schema requires host and share for smb-restic targets', () => {
  const config = defaultConfig()
  config.storage.backup.target = { type: 'smb-restic', path: '/Volumes/backup' }
  const problems = validateConfig(config)
  assert.ok(problems.some((p) => p.path === 'storage.backup.target.host'))
  assert.ok(problems.some((p) => p.path === 'storage.backup.target.share'))
})

test('schema requires a working directory when the agent is enabled', () => {
  const config = defaultConfig()
  config.agent.enabled = true
  config.agent.workingDirectory = '  '
  assert.ok(validateConfig(config).some((p) => p.path === 'agent.workingDirectory'))
})

test('schema rejects duplicate capability ids', () => {
  const config = defaultConfig()
  config.capabilities.enabled = ['a', 'a']
  assert.ok(validateConfig(config).some((p) => p.message.includes('duplicate')))
})