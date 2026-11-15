import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, configPath } from '../src/config.js'
import {
  auditFile,
  chunkBody,
  describeNotify,
  DEDUPE_WINDOW_MS,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_MESSAGE,
  messageKey,
  notify,
  readKeychain,
  stateFile,
} from '../src/notify.js'

const SECRET = 'bark-device-key-do-not-log'

function sandbox({ primary = 'bark', secret = SECRET } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'station-notify-'))
  const config = defaultConfig()
  config.notifications = { primary, bark: { secretRef: 'station.bark.key' } }
  writeFileSync(configPath({ cwd: dir }), JSON.stringify(config, null, 2))
  return { dir, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function fakeFetch({ ok = true, status = 200 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok, status }
  }
  impl.calls = calls
  return impl
}

const okSecret = () => ({ ok: true, secret: SECRET })

test('chunkBody keeps short bodies intact and prefixes long ones', () => {
  assert.deepEqual(chunkBody('short'), ['short'])
  const long = 'x'.repeat(4000)
  const chunks = chunkBody(long)
  assert.ok(chunks.length >= 3)
  assert.match(chunks[0], /^\(1\/\d+\) /)
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 1500 + 16, 'chunk must respect the byte budget')
  }
})

test('chunkBody never splits a multi-byte character', () => {
  const body = '中'.repeat(2000) // 3 bytes each
  for (const chunk of chunkBody(body)) {
    assert.ok(!chunk.includes('\uFFFD'))
  }
})

test('messageKey is stable and body-sensitive', () => {
  const a = messageKey({ connector: 'bark', title: 't', body: 'b' })
  const b = messageKey({ connector: 'bark', title: 't', body: 'b' })
  const c = messageKey({ connector: 'bark', title: 't', body: 'c' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('notify refuses when the primary connector is none', async () => {
  const s = sandbox()
  try {
    const config = { ...s.config, notifications: { primary: 'none' } }
    const result = await notify({ cwd: s.dir, config, title: 't', body: 'b' })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'config')
  } finally {
    s.cleanup()
  }
})

test('notify fails closed when the qq block is incomplete', async () => {
  const s = sandbox({ primary: 'qq' })
  try {
    // secretRef present but appId missing: must never reach the network.
    const config = { ...s.config, notifications: { primary: 'qq', qq: { secretRef: 'station.qq.appSecret' } } }
    const fetch = fakeFetch()
    const result = await notify({
      cwd: s.dir,
      config,
      title: 't',
      body: 'b',
      deps: { fetchImpl: fetch, readSecret: okSecret },
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'config')
    assert.match(result.error, /appId/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    s.cleanup()
  }
})

test('notify delivers through qq: token first, then the C2C message', async () => {
  const s = sandbox({ primary: 'qq' })
  try {
    const calls = []
    const fetch = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('getAppAccessToken')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', expires_in: 7200 }) }
      return { ok: true, status: 200, json: async () => ({ id: 'msg-1' }) }
    }
    const config = {
      ...s.config,
      notifications: {
        primary: 'qq',
        qq: { appId: '102880683', secretRef: 'station.qq.appSecret', allowFrom: ['openid-abc'] },
      },
    }
    const result = await notify({ cwd: s.dir, config, title: 'hello', body: 'world', deps: { fetchImpl: fetch, readSecret: okSecret } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /getAppAccessToken/)
    assert.deepEqual(JSON.parse(calls[0].init.body), { appId: '102880683', clientSecret: SECRET })
    assert.match(calls[1].url, /\/v2\/users\/openid-abc\/messages/)
    assert.equal(calls[1].init.headers.authorization, 'QQBot tok-123')
    assert.match(JSON.parse(calls[1].init.body).content, /hello/)
    assert.ok(!readFileSync(auditFile(s.dir), 'utf8').includes(SECRET))
    assert.ok(!readFileSync(auditFile(s.dir), 'utf8').includes('tok-123'), 'audit must not contain the bearer token')
  } finally {
    s.cleanup()
  }
})

test('notify reports a missing keychain entry and never leaks the secret', async () => {
  const s = sandbox()
  try {
    const result = await notify({
      cwd: s.dir,
      config: s.config,
      title: 't',
      body: 'b',
      deps: { readSecret: () => ({ ok: false, error: 'keychain entry station.bark.key not found' }), fetchImpl: fakeFetch() },
    })
    assert.equal(result.stage, 'secret')
    assert.ok(!JSON.stringify(result).includes(SECRET))
  } finally {
    s.cleanup()
  }
})

test('notify sends through bark with the secret only in the request body', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch()
    const result = await notify({
      cwd: s.dir,
      config: s.config,
      title: 'hello',
      body: 'world',
      deps: { fetchImpl: fetch, readSecret: okSecret },
    })
    assert.equal(result.ok, true)
    assert.equal(fetch.calls.length, 1)
    assert.equal(fetch.calls[0].body.device_key, SECRET)
    assert.equal(fetch.calls[0].body.title, 'hello')

    const audit = readFileSync(auditFile(s.dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(audit.at(-1).status, 'sent')
    assert.ok(!readFileSync(auditFile(s.dir), 'utf8').includes(SECRET), 'audit log must never contain the secret')
  } finally {
    s.cleanup()
  }
})

test('notify deduplicates the same message within the window', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch()
    const deps = { fetchImpl: fetch, readSecret: okSecret, now: () => 1_000_000 }
    const first = await notify({ cwd: s.dir, config: s.config, title: 't', body: 'b', deps })
    const second = await notify({ cwd: s.dir, config: s.config, title: 't', body: 'b', deps })
    assert.equal(first.ok, true)
    assert.equal(second.deduped, true)
    assert.equal(fetch.calls.length, 1, 'the duplicate must not hit the network')

    const later = await notify({
      cwd: s.dir,
      config: s.config,
      title: 't',
      body: 'b',
      deps: { fetchImpl: fetch, readSecret: okSecret, now: () => 1_000_000 + DEDUPE_WINDOW_MS + 1 },
    })
    assert.equal(later.ok, true)
    assert.equal(later.deduped, undefined)
    assert.equal(fetch.calls.length, 2)
  } finally {
    s.cleanup()
  }
})

test('notify rate limits a burst and audits the drop', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch()
    let clock = 2_000_000
    const deps = { fetchImpl: fetch, readSecret: okSecret, now: () => clock }
    let sent = 0
    for (let i = 0; i < 22; i += 1) {
      const result = await notify({ cwd: s.dir, config: s.config, title: `t${i}`, body: `b${i}`, deps })
      if (result.ok) sent += 1
      else {
        assert.equal(result.stage, 'rate-limit')
        break
      }
      clock += 10
    }
    assert.equal(sent, 20, 'the 21st message in a minute must be refused')
    const audit = readFileSync(auditFile(s.dir), 'utf8')
    assert.match(audit, /rate-limited/)
  } finally {
    s.cleanup()
  }
})

test('notify chunks long bodies into several sends', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch()
    const result = await notify({
      cwd: s.dir,
      config: s.config,
      title: 'long',
      body: 'y'.repeat(3200),
      deps: { fetchImpl: fetch, readSecret: okSecret },
    })
    assert.equal(result.ok, true)
    assert.ok(result.chunks >= 3)
    assert.equal(fetch.calls.length, result.chunks)
  } finally {
    s.cleanup()
  }
})

test('notify surfaces transport failures and records them', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch({ ok: false, status: 500 })
    const result = await notify({
      cwd: s.dir,
      config: s.config,
      title: 't',
      body: 'b',
      deps: { fetchImpl: fetch, readSecret: okSecret },
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'transport')
    assert.match(readFileSync(auditFile(s.dir), 'utf8'), /"status":"failed"/)
  } finally {
    s.cleanup()
  }
})

test('dry run resolves the secret path but sends nothing', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch()
    let secretRead = false
    const result = await notify({
      cwd: s.dir,
      config: s.config,
      title: 't',
      body: 'b',
      dryRun: true,
      deps: {
        fetchImpl: fetch,
        readSecret: () => {
          secretRead = true
          return { ok: true, secret: SECRET }
        },
      },
    })
    assert.equal(result.dryRun, true)
    assert.equal(fetch.calls.length, 0)
    assert.equal(secretRead, true, 'dry run should verify the secret is resolvable')
    assert.ok(!existsSync(auditFile(s.dir)), 'dry run must not write an audit record')
  } finally {
    s.cleanup()
  }
})

test('readKeychain is honest about unsupported platforms', () => {
  const result = readKeychain({ ref: 'x', platform: 'linux' })
  assert.equal(result.ok, false)
  assert.match(result.error, /not supported/)
})

test('describeNotify summarises each outcome', () => {
  assert.match(describeNotify({ ok: true, dryRun: true, connector: 'bark', chunks: 1 }), /dry run/)
  assert.match(describeNotify({ ok: true, deduped: true }), /deduplicated/)
  assert.match(describeNotify({ ok: true, connector: 'bark', chunks: 2 }), /sent via bark/)
  assert.match(describeNotify({ ok: false, stage: 'secret', error: 'x' }), /failed at secret/)
})
test('a message that needs too many chunks is refused before sending', async () => {
  const s = sandbox()
  try {
    const fetch = fakeFetch()
    const result = await notify({
      cwd: s.dir,
      config: s.config,
      title: 'huge',
      body: 'z'.repeat(MAX_CHUNK_BYTES * (MAX_CHUNKS_PER_MESSAGE + 2)),
      deps: { fetchImpl: fetch, readSecret: okSecret },
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'too-large')
    assert.equal(fetch.calls.length, 0)
  } finally {
    s.cleanup()
  }
})

test('a failed send keeps the request budget charged but allows an immediate retry', async () => {
  const s = sandbox()
  try {
    const failing = fakeFetch({ ok: false, status: 500 })
    const first = await notify({ cwd: s.dir, config: s.config, title: 't', body: 'b', deps: { fetchImpl: failing, readSecret: okSecret } })
    assert.equal(first.ok, false)

    const state = JSON.parse(readFileSync(stateFile(s.dir), 'utf8'))
    assert.ok(state.windowCount >= 1, 'a failed attempt must still count against the minute budget')
    assert.equal(Object.keys(state.recent).length, 0, 'a failed message must not be deduplicated')

    const ok = fakeFetch()
    const retry = await notify({ cwd: s.dir, config: s.config, title: 't', body: 'b', deps: { fetchImpl: ok, readSecret: okSecret } })
    assert.equal(retry.ok, true)
    assert.equal(ok.calls.length, 1)
  } finally {
    s.cleanup()
  }
})

test('the audit log keeps a title hash instead of the raw title', () => {
  const s = sandbox()
  return notify({ cwd: s.dir, config: s.config, title: 'secret project alpha', body: 'b', deps: { fetchImpl: fakeFetch(), readSecret: okSecret } })
    .then(() => {
      const log = readFileSync(auditFile(s.dir), 'utf8')
      assert.ok(!log.includes('secret project alpha'), 'raw title must not be persisted')
      const record = JSON.parse(log.trim().split('\n').at(-1))
      assert.match(record.titleHash, /^[0-9a-f]{12}$/)
    })
    .finally(() => s.cleanup())
})
