import test from 'node:test'
import assert from 'node:assert/strict'
import { main, summarize, version } from '../src/cli.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'station-cli-'))
  const out = []
  const err = []
  const io = {
    cwd: dir,
    env: process.env,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  }
  return { dir, io, out, err, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('help prints usage and exits 0', async () => {
  const h = harness()
  try {
    assert.equal(await main(['help'], h.io), 0)
    assert.match(h.out.join(''), /station doctor/)
  } finally {
    h.cleanup()
  }
})

test('version prints the package version', async () => {
  const h = harness()
  try {
    assert.equal(await main(['version'], h.io), 0)
    assert.equal(h.out.join('').trim(), version())
  } finally {
    h.cleanup()
  }
})

test('unknown command exits 2 and explains on stderr', async () => {
  const h = harness()
  try {
    assert.equal(await main(['bogus'], h.io), 2)
    assert.match(h.err.join(''), /unknown command: bogus/)
  } finally {
    h.cleanup()
  }
})

test('doctor --json emits parseable output with a summary', async () => {
  const h = harness()
  try {
    const code = await main(['doctor', '--json'], h.io)
    const payload = JSON.parse(h.out.join(''))
    assert.ok(Array.isArray(payload.checks))
    assert.ok(payload.summary.ok >= 0)
    assert.ok([0, 1, 2].includes(code))
  } finally {
    h.cleanup()
  }
})

test('init then status runs against the written config', async () => {
  const h = harness()
  try {
    assert.equal(await main(['init'], h.io), 0)
    assert.match(h.out.join(''), /created/)
    await main(['status', '--json'], h.io)
    const payload = JSON.parse(h.out.slice(-1).join(''))
    assert.ok(Array.isArray(payload.capabilities))
  } finally {
    h.cleanup()
  }
})

test('plan reports read-only actions', async () => {
  const h = harness()
  try {
    assert.equal(await main(['plan'], h.io), 0)
    assert.match(h.out.join(''), /read-only/)
  } finally {
    h.cleanup()
  }
})

test('summarize counts statuses', () => {
  assert.deepEqual(summarize([{ status: 'ok' }, { status: 'critical' }]), {
    ok: 1,
    warn: 0,
    critical: 1,
    unknown: 0,
  })
})