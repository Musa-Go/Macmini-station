import test from 'node:test'
import assert from 'node:assert/strict'
import {
  QQ_API_BASE,
  QQ_ERROR_STAGES,
  QQ_TOKEN_URL,
  deliverQQ,
  fetchAccessToken,
  qqRecipient,
  sendMessage,
} from '../src/connectors/qq.js'
import { defaultConfig } from '../src/config.js'

const SECRET = 'qq-app-secret-do-not-log'

function qqConfig({ allowFrom = ['openid-abc'], to } = {}) {
  const config = defaultConfig()
  config.notifications = {
    primary: 'qq',
    qq: { appId: '102880683', secretRef: 'station.qq.appSecret', allowFrom, ...(to ? { to } : {}) },
  }
  return config
}

function scriptedFetch(steps) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const step = steps.shift()
    if (!step) throw new Error('unexpected request: ' + url)
    if (step.throws) throw new Error(step.throws)
    return { ok: step.ok !== false, status: step.status ?? 200, json: async () => step.body ?? {} }
  }
  impl.calls = calls
  return impl
}

test('qqRecipient prefers an explicit `to` and falls back to the allowlist', () => {
  assert.deepEqual(qqRecipient(qqConfig({ to: 'openid-explicit' })), { ok: true, openid: 'openid-explicit' })
  assert.deepEqual(qqRecipient(qqConfig({ allowFrom: ['  openid-a  ', 'openid-b'] })), { ok: true, openid: 'openid-a' })

  const empty = defaultConfig()
  empty.notifications = { primary: 'qq', qq: { appId: 'x', secretRef: 'r', allowFrom: [] } }
  const result = qqRecipient(empty)
  assert.equal(result.ok, false)
  assert.match(result.error, /allowFrom/)
})

test('fetchAccessToken returns the token and never echoes the secret in errors', async () => {
  const fetch = scriptedFetch([{ body: { access_token: 'tok-1', expires_in: 7200 } }])
  const { token } = await fetchAccessToken({ appId: '102880683', secret: SECRET, fetchImpl: fetch })
  assert.equal(token, 'tok-1')
  assert.equal(fetch.calls[0].url, QQ_TOKEN_URL)
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { appId: '102880683', clientSecret: SECRET })

  const failing = scriptedFetch([{ ok: false, status: 401, body: {} }])
  await assert.rejects(
    () => fetchAccessToken({ appId: '102880683', secret: SECRET, fetchImpl: failing }),
    (error) => {
      assert.equal(error.stage, 'token')
      assert.equal(error.status, 401)
      assert.ok(!String(error.message).includes(SECRET), 'error must not contain the secret')
      return true
    },
  )
})

test('fetchAccessToken rejects a payload without access_token', async () => {
  const fetch = scriptedFetch([{ body: { code: 100016 } }])
  await assert.rejects(
    () => fetchAccessToken({ appId: 'a', secret: 's', fetchImpl: fetch }),
    (error) => {
      assert.equal(error.stage, 'token')
      assert.match(error.message, /access_token/)
      return true
    },
  )
})

test('sendMessage posts to the C2C endpoint with the bearer token and appid header', async () => {
  const fetch = scriptedFetch([{ body: { id: 'm1' } }])
  const result = await sendMessage({ appId: '102880683', token: 'tok-1', openid: 'openid-abc', content: 'hi', fetchImpl: fetch })
  assert.equal(result.ok, true)
  const call = fetch.calls[0]
  assert.equal(call.url, `${QQ_API_BASE}/v2/users/openid-abc/messages`)
  assert.equal(call.init.headers.authorization, 'QQBot tok-1')
  assert.equal(call.init.headers['x-union-appid'], '102880683')
  assert.deepEqual(JSON.parse(call.init.body), { content: 'hi', msg_type: 0 })
})

test('sendMessage url-encodes the openid and surfaces HTTP failures as stage=send', async () => {
  const fetch = scriptedFetch([{ ok: false, status: 403, body: { message: 'no permission' } }])
  await assert.rejects(
    () => sendMessage({ appId: 'a', token: 't', openid: 'open/id with space', content: 'x', fetchImpl: fetch }),
    (error) => {
      assert.equal(error.stage, 'send')
      assert.equal(error.status, 403)
      assert.match(error.message, /no permission/)
      return true
    },
  )
  assert.match(fetch.calls[0].url, /open%2Fid%20with%20space/)
})

test('deliverQQ requires appId before any request is made', async () => {
  const config = defaultConfig()
  config.notifications = { primary: 'qq', qq: { secretRef: 'station.qq.appSecret', allowFrom: ['openid-abc'] } }
  const fetch = scriptedFetch([])
  await assert.rejects(
    () => deliverQQ({ config, secret: SECRET, content: 'x', fetchImpl: fetch }),
    (error) => {
      assert.equal(error.stage, 'config')
      assert.match(error.message, /appId/)
      return true
    },
  )
  assert.equal(fetch.calls.length, 0, 'a config error must not reach the network')
})

test('deliverQQ runs token then send in one call', async () => {
  const fetch = scriptedFetch([{ body: { access_token: 'tok-9' } }, { body: { id: 'm2' } }])
  const result = await deliverQQ({ config: qqConfig(), secret: SECRET, content: 'hello', fetchImpl: fetch })
  assert.equal(result.ok, true)
  assert.equal(fetch.calls.length, 2)
})

test('QQ error stages are a closed set', () => {
  assert.deepEqual([...QQ_ERROR_STAGES].sort(), ['config', 'send', 'token'])
})