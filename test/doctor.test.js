import test from 'node:test'
import assert from 'node:assert/strict'
import { runDoctor, formatChecks, summarizeChecks } from '../src/doctor.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'station-doctor-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('doctor returns a stable set of checks with valid statuses', () => {
  const { dir, cleanup } = tempDir()
  try {
    const checks = runDoctor({ cwd: dir, root: ROOT })
    const ids = checks.map((c) => c.id).sort()
    assert.deepEqual(
      ids,
      ['agent', 'backup', 'config', 'docker', 'git', 'node', 'notifications', 'platform', 'profile', 'remote', 'restic'].sort(),
    )
    for (const check of checks) {
      assert.ok(['ok', 'warn', 'critical', 'unknown'].includes(check.status), `bad status: ${check.status}`)
      assert.equal(typeof check.detail, 'string')
      assert.ok(check.detail.length > 0)
    }
  } finally {
    cleanup()
  }
})

test('doctor warns when station.json is missing and after init only reports config ok', () => {
  const { dir, cleanup } = tempDir()
  try {
    const before = runDoctor({ cwd: dir, root: ROOT })
    const configBefore = before.find((c) => c.id === 'config')
    assert.equal(configBefore.status, 'warn')

    // Minimal but valid config written by hand to keep this test independent of init.
    writeFileSync(
      join(dir, 'station.json'),
      JSON.stringify({
        schemaVersion: 1,
        machine: { displayName: 'test', profile: 'macos-apple-silicon' },
        storage: {
          backup: {
            enabled: true,
            target: { type: 'local', path: join(dir, 'backups') },
            schedule: '30 3 * * *',
            retention: { daily: 7, weekly: 4, monthly: 6 },
          },
        },
        remoteAccess: { enabled: false, provider: 'tailscale' },
        notifications: { primary: 'none' },
        agent: { enabled: false, workingDirectory: '' },
        capabilities: { enabled: ['local-backup'] },
      }),
    )

    const after = runDoctor({ cwd: dir, root: ROOT })
    assert.equal(after.find((c) => c.id === 'config').status, 'ok')
    assert.equal(after.find((c) => c.id === 'backup').status, 'warn')
  } finally {
    cleanup()
  }
})

test('doctor flags a broken config as critical', () => {
  const { dir, cleanup } = tempDir()
  try {
    writeFileSync(join(dir, 'station.json'), '{ broken')
    const checks = runDoctor({ cwd: dir, root: ROOT })
    assert.equal(checks.find((c) => c.id === 'config').status, 'critical')
  } finally {
    cleanup()
  }
})

test('formatChecks includes every check and a summary line', () => {
  const { dir, cleanup } = tempDir()
  try {
    const checks = runDoctor({ cwd: dir, root: ROOT })
    const text = formatChecks(checks)
    for (const check of checks) assert.ok(text.includes(check.title))
    assert.match(text, /ok \d+ · warn \d+ · critical \d+ · unknown \d+/)
  } finally {
    cleanup()
  }
})

test('summarizeChecks counts each status', () => {
  const summary = summarizeChecks([
    { status: 'ok' },
    { status: 'ok' },
    { status: 'warn' },
    { status: 'unknown' },
  ])
  assert.deepEqual(summary, { ok: 2, warn: 1, critical: 0, unknown: 1 })
})