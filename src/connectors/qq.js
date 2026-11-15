/**
 * QQ official-bot outbound delivery (M3.3).
 *
 * This module never ships credentials and never stores a token on disk:
 *   - appId comes from station.json (not a secret);
 *   - the app secret is resolved from the system keychain by reference;
 *   - the access token lives only in memory for the duration of one command.
 *
 * A short-lived CLI does two HTTP calls per send (token + message). That is
 * intentional: caching a bearer token on disk would put a secret at rest for the
 * sake of saving one request.
 */

export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
export const QQ_API_BASE = 'https://api.sgroup.qq.com'
export const QQ_ERROR_STAGES = ['config', 'token', 'send']

export function qqRecipient(config) {
  const qq = config.notifications?.qq ?? {}
  const explicit = typeof qq.to === 'string' && qq.to.trim() !== '' ? qq.to.trim() : ''
  if (explicit) return { ok: true, openid: explicit }
  const allowFrom = Array.isArray(qq.allowFrom) ? qq.allowFrom.filter((x) => typeof x === 'string' && x.trim() !== '') : []
  if (allowFrom.length === 0) {
    return { ok: false, error: 'notifications.qq.allowFrom is empty; add the openid that may receive messages' }
  }
  return { ok: true, openid: allowFrom[0].trim() }
}

export class QQError extends Error {
  constructor(stage, message, { status = null } = {}) {
    super(message)
    this.name = 'QQError'
    this.stage = stage
    this.status = status
  }
}

async function postJson({ url, body, headers = {}, fetchImpl, timeoutMs = 8000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    return { ok: response.ok === true, status: response.status, payload }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: null, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchAccessToken({ appId, secret, fetchImpl }) {
  const result = await postJson({
    url: QQ_TOKEN_URL,
    body: { appId, clientSecret: secret },
    fetchImpl,
  })
  if (!result.ok) throw new QQError('token', result.error ?? `token endpoint returned HTTP ${result.status}`, { status: result.status })
  const token = result.payload?.access_token
  if (typeof token !== 'string' || token === '') {
    throw new QQError('token', 'token endpoint did not return access_token')
  }
  return { token, expiresIn: Number(result.payload?.expires_in ?? 0) }
}

export async function sendMessage({ appId, token, openid, content, fetchImpl }) {
  const result = await postJson({
    url: `${QQ_API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`,
    body: { content, msg_type: 0 },
    headers: { authorization: `QQBot ${token}`, 'x-union-appid': appId },
    fetchImpl,
  })
  if (!result.ok) {
    // Never echo the token or the payload: only a stable stage and status.
    const detail = result.payload?.message ?? result.error ?? ''
    throw new QQError('send', `message endpoint returned HTTP ${result.status}${detail ? `: ${String(detail).slice(0, 120)}` : ''}`, {
      status: result.status,
    })
  }
  return { ok: true, status: result.status }
}

/**
 * Deliver one (already chunked) message. Throws QQError; the caller turns it
 * into a structured result and audits it.
 */
/**
 * Passive reply: QQ only allows a bot to answer an inbound message it just
 * received, addressed by that message's id, within a short window. C2C allows up
 * to 4 replies per inbound message, groups up to 5, hence `msgSeq`.
 */
export async function sendReply({ appId, token, target, content, msgId, msgSeq = 1, fetchImpl }) {
  const path = target.kind === 'group'
    ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages`
    : `/v2/users/${encodeURIComponent(target.openid)}/messages`
  const result = await postJson({
    url: `${QQ_API_BASE}${path}`,
    body: { content, msg_type: 0, msg_id: msgId, msg_seq: msgSeq },
    headers: { authorization: `QQBot ${token}`, 'x-union-appid': appId },
    fetchImpl,
  })
  if (!result.ok) {
    const detail = result.payload?.message ?? result.error ?? ''
    throw new QQError('send', `passive reply failed with HTTP ${result.status}${detail ? `: ${String(detail).slice(0, 120)}` : ''}`, {
      status: result.status,
    })
  }
  return { ok: true, status: result.status }
}

export async function deliverQQ({ config, secret, content, fetchImpl }) {
  const qq = config.notifications?.qq ?? {}
  if (typeof qq.appId !== 'string' || qq.appId.trim() === '') {
    throw new QQError('config', 'notifications.qq.appId is required')
  }
  const recipient = qqRecipient(config)
  if (!recipient.ok) throw new QQError('config', recipient.error)

  const { token } = await fetchAccessToken({ appId: qq.appId.trim(), secret, fetchImpl })
  return sendMessage({ appId: qq.appId.trim(), token, openid: recipient.openid, content, fetchImpl })
}