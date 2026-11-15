/**
 * Feishu / Lark custom-bot notifications (M3.6).
 *
 * The webhook URL itself is a credential (it embeds the bot token), so the config
 * only stores a keychain reference and the URL is resolved at send time.
 *
 * Two details that bite in practice:
 *   1. Feishu answers HTTP 200 even when it rejects a payload; the body carries a
 *      `code` that must be 0. Treating 200 as success silently loses messages.
 *   2. When 加签 (signature verification) is enabled, the signature is
 *      base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = "")).
 */

import { createHmac } from 'node:crypto'

export const FEISHU_HOSTS = ['open.feishu.cn', 'open.larksuite.com']
export const FEISHU_WEBHOOK_PATH = '/open-apis/bot/v2/hook/'

export function signFeishu({ timestamp, secret }) {
  const key = `${timestamp}\n${secret}`
  return createHmac('sha256', key).update('').digest('base64')
}

/**
 * Only send to a real Feishu/Lark custom-bot endpoint: the URL comes from the
 * keychain, but validating it stops a mistyped or swapped entry from turning this
 * into a POST-to-anywhere primitive.
 */
export function validateWebhookUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return { ok: false, error: 'webhook URL is not a valid URL' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'webhook URL must use https' }
  if (!FEISHU_HOSTS.includes(url.hostname)) {
    return { ok: false, error: `webhook host must be one of ${FEISHU_HOSTS.join(', ')}, got ${url.hostname}` }
  }
  if (!url.pathname.startsWith(FEISHU_WEBHOOK_PATH)) {
    return { ok: false, error: `webhook path must start with ${FEISHU_WEBHOOK_PATH}` }
  }
  const token = url.pathname.slice(FEISHU_WEBHOOK_PATH.length)
  if (token === '') return { ok: false, error: 'webhook URL has no bot token' }
  return { ok: true, url }
}

export function buildPayload({ title, body, secret, now = Date.now() }) {
  const text = [title, body].filter((part) => typeof part === 'string' && part !== '').join('\n')
  if (!secret) return { msg_type: 'text', content: { text } }
  const timestamp = String(Math.floor(now / 1000))
  return { timestamp, sign: signFeishu({ timestamp, secret }), msg_type: 'text', content: { text } }
}

/**
 * Send one text message. Returns a structured result; a rejection is a failure,
 * not a success with a strange body.
 */
export async function sendFeishu({
  webhookUrl,
  signSecret,
  title,
  body,
  fetchImpl,
  timeoutMs = 8000,
  now = Date.now,
}) {
  const target = validateWebhookUrl(webhookUrl)
  if (!target.ok) return { ok: false, stage: 'config', error: target.error }
  if (typeof fetchImpl !== 'function') return { ok: false, stage: 'transport', error: 'no fetch implementation available' }

  const payload = buildPayload({ title, body, secret: signSecret, now: now() })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(target.url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    })
    let parsed = null
    try {
      parsed = await response.json()
    } catch {
      parsed = null
    }
    const code = parsed?.code
    if (response.ok !== true) {
      return { ok: false, stage: 'transport', status: response.status, error: `HTTP ${response.status}` }
    }
    if (typeof code === 'number' && code !== 0) {
      return {
        ok: false,
        stage: 'rejected',
        status: response.status,
        code,
        error: `feishu rejected the message: code ${code}${parsed?.msg ? ` (${String(parsed.msg).slice(0, 120)})` : ''}`,
      }
    }
    return { ok: true, status: response.status, code: typeof code === 'number' ? code : 0 }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, stage: 'transport', error: reason }
  } finally {
    clearTimeout(timer)
  }
}