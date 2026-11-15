import test from 'node:test'
import assert from 'node:assert/strict'
import { loadCapabilities, probeCapabilities, validateManifest } from '../src/capabilities.js'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'station-caps-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('shipped capabilities are valid manifests', () => {
  const capabilities = loadCapabilities({ cwd: '/nonexistent-cwd', root: ROOT })
  assert.ok(capabilities.length >= 2)
  for (const capability of capabilities) {
    assert.deepEqual(capability.problems, [], `${capability.id} has manifest problems`)
    assert.equal(typeof capability.probe, 'object')
  }
})

test('validateManifest rejects unknown kinds and missing fields', () => {
  assert.ok(validateManifest({}).length >= 3)
  assert.ok(validateManifest({ id: 'x', title: 'x', summary: 'x', kind: 'magic' }).some((p) => p.includes('kind')))
})

test('user capabilities override shipped ones with the same id', () => {
  const { dir, cleanup } = tempDir()
  try {
    mkdirSync(join(dir, 'capabilities'))
    writeFileSync(
      join(dir, 'capabilities', 'local-backup.json'),
      JSON.stringify({ id: 'local-backup', title: 'Custom backup', summary: 'override', kind: 'path', probe: { path: dir } }),
    )
    const capabilities = loadCapabilities({ cwd: dir, root: ROOT })
    const found = capabilities.find((c) => c.id === 'local-backup')
    assert.equal(found.title, 'Custom backup')
    assert.equal(capabilities.filter((c) => c.id === 'local-backup').length, 1)
  } finally {
    cleanup()
  }
})

test('probeCapabilities maps results to statuses and honours enable list', async () => {
  const { dir, cleanup } = tempDir()
  try {
    const capabilities = [
      { id: 'present', title: 'Present', summary: 'x', kind: 'path', probe: { path: dir } },
      { id: 'absent', title: 'Absent', summary: 'x', kind: 'path', probe: { path: join(dir, 'nope') } },
      { id: 'optional-absent', title: 'Optional', summary: 'x', kind: 'path', optional: true, probe: { path: join(dir, 'nope') } },
      { id: 'disabled', title: 'Disabled', summary: 'x', kind: 'path', probe: { path: dir } },
      { id: 'broken', title: 'Broken', summary: 'x', kind: 'http', problems: ['bad'] },
    ]
    const results = await probeCapabilities(capabilities, {
      config: { capabilities: { enabled: ['present', 'absent', 'optional-absent', 'broken'] } },
    })
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]))
    assert.equal(byId.present, 'ok')
    assert.equal(byId.absent, 'critical')
    assert.equal(byId['optional-absent'], 'warn')
    assert.equal(byId.disabled, 'unknown')
    assert.equal(byId.broken, 'critical')
  } finally {
    cleanup()
  }
})