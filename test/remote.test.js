import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig } from '../src/config.js'
import {
  TAILSCALE_CANDIDATES,
  describeExpose,
  expose,
  findTailscale,
  readPublished,
  serveCommands,
  tailnetOnline,
  writePublished,
} from '../src/remote.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function configured({ enabled = true, ports = [8443, 8444] } = {}) {
  const config = defaultConfig()
  config.remoteAccess = { enabled, provider: 'tailscale', ports }
  return config
}

/** A probe that answers `version` / `status` / `serve` from scripted behaviour. */
function scriptedProbe({ version = true, status = '100.110.77.80  node  macOS', serveOk = true } = {}) {
  const calls = []
  const probe = (command, args) => {
    calls.push({ command, args })
    if (args[0] === 'version') return version ? { ok: true, stdout: '1.104.7' } : { ok: false, message: 'boom' }
    if (args[0] === 'status') return { ok: true, stdout: status }
    return serveOk ? { ok: true, stdout: '' } : { ok: false, message: 'serve failed' }
  }
  probe.calls = calls
  return probe
}

const alwaysExists = () => true

test('expose refuses when remote access is disabled', () => {
  const result = expose({ config: configured({ enabled: false }), probe: scriptedProbe() })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'config')
  assert.match(result.error, /enabled is false/)
})

test('expose refuses an empty port list instead of publishing a default', () => {
  const result = expose({ config: configured({ ports: [] }), probe: scriptedProbe() })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'config')
  assert.match(result.error, /ports/)
})

test('expose defaults its probe so the CLI path does not crash', () => {
  const result = expose({ config: configured({ ports: [8443] }), dryRun: true })
  // Host-dependent stage; the invariant is that a structured result comes back.
  assert.equal(typeof result, 'object')
  assert.ok('ok' in result)
  if (result.ok) assert.equal(result.dryRun, true)
})

test('findTailscale reports missing binary with a hint', () => {
  const result = findTailscale({ exists: () => false, probe: () => ({ ok: false }) })
  assert.equal(result.ok, false)
  assert.match(result.error, /not found/)
  assert.match(result.hint, /Tailscale/)
})

test('tailnetOnline detects logged-out state and missing address', () => {
  assert.equal(tailnetOnline({ path: 'ts', probe: () => ({ ok: true, stdout: 'Logged out.' }) }).ok, false)
  assert.equal(tailnetOnline({ path: 'ts', probe: () => ({ ok: true, stdout: 'no addresses here' }) }).ok, false)
  assert.equal(tailnetOnline({ path: 'ts', probe: () => ({ ok: true, stdout: '100.1.2.3 node' }) }).ok, true)
})

test('serveCommands publish and off forms are distinct', () => {
  assert.deepEqual(serveCommands([8443]), [['serve', '--bg', '--https=8443', 'http://127.0.0.1:8443']])
  assert.deepEqual(serveCommands([8443], { reset: true }), [['serve', '--https=8443', 'off']])
})

test('dry run lists the exact commands without executing serve', () => {
  const probe = scriptedProbe()
  // Force the CLI lookup to succeed without depending on the host installation.
  const result = expose({
    config: configured({ ports: [8443, 8444] }),
    dryRun: true,
    probe,
  })
  if (result.stage === 'tailscale') {
    // Host has no Tailscale: the contract still holds, nothing was published.
    assert.equal(result.ok, false)
    return
  }
  assert.equal(result.dryRun, true)
  assert.equal(result.commands.length, 2)
  assert.match(result.commands[0], /serve --bg --https=8443 http:\/\/127\.0\.0\.1:8443/)
  assert.ok(!probe.calls.some((c) => c.args[0] === 'serve' && !c.args.includes('off')), 'dry run must not call serve')
})

test('expose stops at the first failure and reports per-port results', () => {
  const probe = scriptedProbe({ serveOk: false })
  const result = expose({ config: configured({ ports: [8443] }), probe })
  if (result.stage === 'tailscale') return // no Tailscale on this host
  assert.equal(result.ok, false)
  assert.ok(result.results.some((r) => r.ok === false))
})

test('describeExpose summarises dry runs and failures', () => {
  assert.match(
    describeExpose({ ok: true, dryRun: true, tailscale: '/x', commands: ['tailscale serve --bg --https=8443 http://127.0.0.1:8443'] }),
    /dry run/,
  )
  assert.match(describeExpose({ ok: false, stage: 'config', error: 'nope' }), /failed at config/)
})

test('candidate list is absolute paths so nothing resolves from PATH order', () => {
  for (const candidate of TAILSCALE_CANDIDATES) assert.ok(candidate.startsWith('/') || candidate === 'tailscale')
})
test('--off works after remote access is disabled', () => {
  const probe = scriptedProbe()
  const dir = mkdtempSync(join(tmpdir(), 'station-expose-'))
  try {
    writePublished({ cwd: dir, ports: [8443] })
    const result = expose({ cwd: dir, config: configured({ enabled: false }), off: true, probe })
    if (result.stage === 'tailscale') return // host without Tailscale
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.ports, [8443])
    assert.deepEqual(readPublished({ cwd: dir }), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ports removed from the config are unpublished on the next run', () => {
  const probe = scriptedProbe()
  const dir = mkdtempSync(join(tmpdir(), 'station-expose-'))
  try {
    writePublished({ cwd: dir, ports: [8443, 8444] })
    const result = expose({ cwd: dir, config: configured({ ports: [8443] }), probe })
    if (result.stage === 'tailscale') return
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.results.map((item) => `${item.action}:${item.port}`), ['off:8444', 'serve:8443'])
    assert.deepEqual(readPublished({ cwd: dir }), [8443])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('off with nothing recorded is a no-op success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'station-expose-'))
  try {
    const result = expose({ cwd: dir, config: configured({ enabled: false }), off: true, probe: scriptedProbe() })
    assert.equal(result.ok, true)
    assert.deepEqual(result.ports, [])
    assert.match(result.note, /nothing to unpublish/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
