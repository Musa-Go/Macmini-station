import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  FEISHU_HOSTS,
  buildPayload,
  sendFeishu,
  signFeishu,
  validateWebhookUrl,
} from '../src/connectors/feishu.js'

const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/token-abc'
const SECRET = 'feishu-sign-secret'

function fakeFetch({ status = 200, body = { code: 0, msg: 'success' } } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  impl.calls = calls
  return impl
}

test('signFeishu uses timestamp + newline + secret as the HMAC key over an empty payload', () => {
  const sign = signFeishu({ timestamp: '1700000000', secret: SECRET })
  // Independent computation with the same documented recipe.
  const expected = createExpected('1700000000', SECRET)
  assert.equal(sign, expected)
  assert.match(sign, /^[A-Za-z0-9+/]+=*$/)
})

function createExpected(timestamp, secret) {
  // Kept in the test so the production helper is not validated against itself.
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

test('buildPayload omits the signature when no sign secret is configured', () => {
  const payload = buildPayload({ title: 'T', body: 'B' })
  assert.deepEqual(payload, { msg_type: 'text', content: { text: 'T\nB' } })
})

test('buildPayload adds timestamp and sign when 加签 is enabled', () => {
  const payload = buildPayload({ title: 'T', body: 'B', secret: SECRET, now: 1_700_000_000_000 })
  assert.equal(payload.timestamp, '1700000000')
  assert.equal(payload.sign, signFeishu({ timestamp: '1700000000', secret: SECRET }))
  assert.equal(payload.msg_type, 'text')
  assert.equal(payload.content.text, 'T\nB')
})

test('validateWebhookUrl only accepts real Feishu/Lark bot endpoints', () => {
  assert.equal(validateWebhookUrl(WEBHOOK).ok, true)
  assert.equal(validateWebhookUrl('https://open.larksuite.com/open-apis/bot/v2/hook/x').ok, true)

  assert.match(validateWebhookUrl('http://open.feishu.cn/open-apis/bot/v2/hook/x').error, /https/)
  assert.match(validateWebhookUrl('https://example.com/open-apis/bot/v2/hook/x').error, /host must be one of/)
  assert.match(validateWebhookUrl('https://open.feishu.cn/other/path').error, /path must start with/)
  assert.match(validateWebhookUrl('https://open.feishu.cn/open-apis/bot/v2/hook/').error, /no bot token/)
  assert.match(validateWebhookUrl('not a url').error, /not a valid URL/)
})

test('sendFeishu posts a text message and reports success', async () => {
  const fetch = fakeFetch()
  const result = await sendFeishu({ webhookUrl: WEBHOOK, title: 'hello', body: 'world', fetchImpl: fetch })
  assert.equal(result.ok, true)
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].url, WEBHOOK)
  assert.equal(fetch.calls[0].body.msg_type, 'text')
  assert.equal(fetch.calls[0].body.content.text, 'hello\nworld')
  assert.equal(fetch.calls[0].init.redirect, 'error')
})

test('a rejected payload with HTTP 200 is a failure, not a success', async () => {
  const fetch = fakeFetch({ body: { code: 19021, msg: 'sign match fail' } })
  const result = await sendFeishu({ webhookUrl: WEBHOOK, title: 't', body: 'b', fetchImpl: fetch })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'rejected')
  assert.equal(result.code, 19021)
  assert.match(result.error, /19021/)
})

test('an invalid webhook URL never reaches the network', async () => {
  const fetch = fakeFetch()
  const result = await sendFeishu({ webhookUrl: 'https://evil.example/hook/x', title: 't', body: 'b', fetchImpl: fetch })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'config')
  assert.equal(fetch.calls.length, 0)
})

test('a transport error is contained', async () => {
  const result = await sendFeishu({
    webhookUrl: WEBHOOK,
    title: 't',
    body: 'b',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'transport')
  assert.match(result.error, /ECONNREFUSED/)
})

test('the sign secret never appears in the payload as plain text', () => {
  const payload = buildPayload({ title: 't', body: 'b', secret: SECRET, now: 1 })
  assert.ok(!JSON.stringify(payload).includes(SECRET))
})

test('host allowlist is exactly the two official domains', () => {
  assert.deepEqual([...FEISHU_HOSTS].sort(), ['open.feishu.cn', 'open.larksuite.com'])
})
