import test from 'node:test'
import assert from 'node:assert/strict'
import { httpProbe, fileFreshnessProbe, mountProbe, pathExistsProbe } from '../src/probes.js'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('httpProbe reports ok for an accepted status', async () => {
  const result = await httpProbe({
    url: 'http://example.test/health',
    expect: [200],
    fetchImpl: async () => ({ status: 200 }),
  })
  assert.equal(result.ok, true)
  assert.match(result.detail, /200/)
})

test('httpProbe reports the unexpected status instead of throwing', async () => {
  const result = await httpProbe({
    url: 'http://example.test/health',
    expect: [200],
    fetchImpl: async () => ({ status: 503 }),
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /503/)
})

test('httpProbe contains network errors', async () => {
  const result = await httpProbe({
    url: 'http://example.test/health',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.detail, /ECONNREFUSED/)
})

test('fileFreshnessProbe accepts a recent file and rejects a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'station-fresh-'))
  try {
    writeFileSync(join(dir, 'report.md'), 'ok')
    const now = Date.now()
    assert.equal(fileFreshnessProbe({ globDir: dir, maxAgeHours: 26, now }).ok, true)
    const later = now + 48 * 3_600_000
    assert.equal(fileFreshnessProbe({ globDir: dir, maxAgeHours: 26, now: later }).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fileFreshnessProbe reports a missing directory', () => {
  const result = fileFreshnessProbe({ globDir: '/definitely/not/here' })
  assert.equal(result.ok, false)
  assert.match(result.detail, /missing directory/)
})

test('pathExistsProbe distinguishes present and absent paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'station-path-'))
  try {
    assert.equal(pathExistsProbe({ path: dir }).ok, true)
    mkdirSync(join(dir, 'nested'))
    assert.equal(pathExistsProbe({ path: join(dir, 'nested') }).ok, true)
    assert.equal(pathExistsProbe({ path: join(dir, 'absent') }).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mountProbe never throws when the mount table is unreadable', () => {
  const result = mountProbe({ path: '/Volumes/whatever' })
  assert.ok(result.ok === true || result.ok === false || result.ok === null)
  assert.equal(typeof result.detail, 'string')
})