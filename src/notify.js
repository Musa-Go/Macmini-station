/**
 * Notification delivery (M3.2: bark).
 *
 * Design rules from docs/CONNECTORS.md, enforced here:
 *   - the secret is read from the system keychain through a reference; it never
 *     reaches argv, the audit log, or a thrown error;
 *   - identical messages are deduplicated and bursts are rate limited;
 *   - long bodies are chunked with an (i/n) prefix;
 *   - every attempt is recorded locally, successful or not, without the secret.
 *
 * Everything is injectable so tests run offline and with a fake clock.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { stateDir } from './state.js'
import { deliverQQ, QQError } from './connectors/qq.js'

export const DEDUPE_WINDOW_MS = 5 * 60 * 1000
export const RATE_LIMIT_PER_MIN = 20
export const MAX_CHUNK_BYTES = 1500
// A single logical message must not turn into an unbounded burst of requests.
export const MAX_CHUNKS_PER_MESSAGE = 10
const BARK_ENDPOINT = 'https://api.day.app/push'
const SUPPORTED_CONNECTORS = ['bark', 'qq']

export function stateFile(cwd) {
  return join(stateDir(cwd), 'notify-state.json')
}

export function auditFile(cwd) {
  return join(stateDir(cwd), 'notify.log')
}

/** Cross-process lock so concurrent CLI runs cannot overspend the rate limit. */
export function withStateLock(cwd, fn, { retries = 100, waitMs = 25, staleMs = 60_000 } = {}) {
  const path = join(stateDir(cwd), '.notify.lock')
  mkdirSync(stateDir(cwd), { recursive: true })
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        return fn()
      } finally {
        closeSync(fd)
        try {
          unlinkSync(path)
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      // A killed process can leave the lock behind; only break it when it is old.
      try {
        const age = Date.now() - statSync(path).mtimeMs
        if (age > staleMs) unlinkSync(path)
      } catch {}
      const until = Date.now() + waitMs
      while (Date.now() < until) {
        /* short spin: the critical section is a couple of file writes */
      }
    }
  }
  throw new Error('could not acquire the notification state lock; is another station process running?')
}

/** Locked read-modify-write of the dedupe / rate-limit state. */
function mutateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = readState(cwd)
    const result = mutate(state)
    writeState(cwd, state, result?.now ?? Date.now())
    return result
  })
}

function readState(cwd) {
  const path = stateFile(cwd)
  if (!existsSync(path)) return { recent: {}, windowStart: 0, windowCount: 0 }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { recent: parsed.recent ?? {}, windowStart: parsed.windowStart ?? 0, windowCount: parsed.windowCount ?? 0 }
  } catch {
    return { recent: {}, windowStart: 0, windowCount: 0 }
  }
}

function writeState(cwd, state, now) {
  mkdirSync(stateDir(cwd), { recursive: true })
  // keep the dedupe map bounded
  const cutoff = now - DEDUPE_WINDOW_MS
  const recent = Object.fromEntries(Object.entries(state.recent).filter(([, ts]) => ts > cutoff))
  writeFileSync(stateFile(cwd), `${JSON.stringify({ ...state, recent }, null, 2)}\n`, { mode: 0o600 })
}

export function messageKey({ connector, title, body }) {
  return createHash('sha256').update(`${connector}\u0000${title}\u0000${body}`).digest('hex').slice(0, 16)
}

/** Byte-aware chunking so a CJK body never splits mid-codepoint. */
export function chunkBody(body, maxBytes = MAX_CHUNK_BYTES) {
  const text = String(body ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text]
  const chunks = []
  let current = ''
  for (const char of text) {
    if (Buffer.byteLength(current + char, 'utf8') > maxBytes) {
      chunks.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current !== '') chunks.push(current)
  return chunks.map((chunk, index) => `(${index + 1}/${chunks.length}) ${chunk}`)
}

export function readKeychain({ ref, exec = execFileSync, platform = process.platform }) {
  if (platform !== 'darwin') {
    return { ok: false, error: `keychain is not supported on ${platform}` }
  }
  try {
    const value = exec('security', ['find-generic-password', '-s', ref, '-w'], { encoding: 'utf8' })
    const secret = String(value).trim()
    if (secret === '') return { ok: false, error: `keychain entry ${ref} is empty` }
    return { ok: true, secret }
  } catch {
    return { ok: false, error: `keychain entry ${ref} not found; add it with: security add-generic-password -s ${ref} -w <secret>` }
  }
}

export function keychainCommand(ref) {
  return `security add-generic-password -s ${ref} -w <secret>`
}

async function sendBark({ secret, title, body, fetchImpl, timeoutMs = 8000 }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(BARK_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_key: secret, title, body }),
      signal: controller.signal,
    })
    return { ok: response.ok === true, status: response.status }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: null, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deliver one notification through the configured primary connector.
 * Returns a structured result; never throws for transport failures.
 */
export async function notify({
  cwd,
  config,
  title,
  body,
  dryRun = false,
  deps = {},
}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? (() => Date.now())
  const readSecret = deps.readSecret ?? readKeychain
  const notifications = config.notifications ?? {}
  const connector = notifications.primary ?? 'none'

  if (connector === 'none') {
    return { ok: false, stage: 'config', error: 'notifications.primary is none; nothing to deliver' }
  }
  if (!SUPPORTED_CONNECTORS.includes(connector)) {
    return { ok: false, stage: 'connector', error: `${connector} delivery is not implemented yet` }
  }

  const ref = notifications[connector]?.secretRef
  if (!ref) return { ok: false, stage: 'config', error: `notifications.${connector}.secretRef is required` }

  const chunks = chunkBody(body)
  if (chunks.length > MAX_CHUNKS_PER_MESSAGE) {
    return {
      ok: false,
      stage: 'too-large',
      error: `message needs ${chunks.length} chunks but the limit is ${MAX_CHUNKS_PER_MESSAGE}`,
    }
  }
  const key = messageKey({ connector, title, body })
  const timestamp = now()

  // Reserve the slot and the request budget under a lock, before any network I/O:
  // two concurrent runs must not both pass the same limit check.
  const reservation = mutateState(cwd, (state) => {
    if (state.recent[key] && timestamp - state.recent[key] < DEDUPE_WINDOW_MS) {
      return { now: timestamp, deduped: true }
    }
    if (timestamp - state.windowStart > 60_000) {
      state.windowStart = timestamp
      state.windowCount = 0
    }
    // Count actual requests, not messages: one long message used to bypass the cap.
    if (state.windowCount + chunks.length > RATE_LIMIT_PER_MIN) {
      return { now: timestamp, rateLimited: true }
    }
    state.recent[key] = timestamp
    state.windowCount += chunks.length
    return { now: timestamp, reserved: true }
  })

  if (reservation.deduped) return { ok: true, deduped: true, connector, chunks: chunks.length }
  if (reservation.rateLimited) {
    audit(cwd, { timestamp, connector, status: 'rate-limited', title })
    return {
      ok: false,
      stage: 'rate-limit',
      error: `sending ${chunks.length} chunk(s) would exceed ${RATE_LIMIT_PER_MIN} requests per minute`,
      connector,
    }
  }

  const secretResult = readSecret({ ref })
  if (!secretResult.ok) {
    audit(cwd, { timestamp, connector, status: 'secret-missing', title })
    return { ok: false, stage: 'secret', error: secretResult.error }
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      connector,
      chunks: chunks.length,
      wouldSend: { bytes: Buffer.byteLength(String(body ?? ''), 'utf8') },
    }
  }

  if (typeof fetchImpl !== 'function') {
    return { ok: false, stage: 'transport', error: 'no fetch implementation available' }
  }

  let delivered = 0
  for (const chunk of chunks) {
    try {
      if (connector === 'bark') {
        const result = await sendBark({ secret: secretResult.secret, title, body: chunk, fetchImpl })
        if (!result.ok) throw Object.assign(new Error(result.error ?? `HTTP ${result.status}`), { stage: 'transport', status: result.status })
      } else {
        await deliverQQ({ config, secret: secretResult.secret, content: `${title}\n${chunk}`.trim(), fetchImpl })
      }
    } catch (error) {
      const stage = error instanceof QQError ? error.stage : (error && error.stage) || 'transport'
      const status = typeof error?.status === 'number' ? error.status : null
      // Keep the request budget charged (it was reserved before sending) but drop
      // the dedupe marker so the operator can retry a failed message immediately.
      mutateState(cwd, (state) => {
        delete state.recent[key]
        return { now: timestamp }
      })
      audit(cwd, { timestamp, connector, status: 'failed', title, httpStatus: status, chunks: delivered })
      return { ok: false, stage, error: String(error?.message ?? error), connector, delivered }
    }
    delivered += 1
  }

  audit(cwd, { timestamp, connector, status: 'sent', title, chunks: delivered })
  return { ok: true, connector, chunks: delivered }
}

function audit(cwd, { timestamp, connector, status, title, chunks, httpStatus }) {
  // Audit records keep a title hash and a short prefix only: titles can carry
  // personal context, and the log must stay safe to share in a bug report.
  try {
    mkdirSync(stateDir(cwd), { recursive: true })
    const safeTitle = String(title ?? '')
    const record = {
      ts: new Date(timestamp).toISOString(),
      connector,
      status,
      titleHash: createHash('sha256').update(safeTitle).digest('hex').slice(0, 12),
      titlePrefix: safeTitle.slice(0, 12),
      chunks: chunks ?? 0,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    }
    appendFileSync(auditFile(cwd), `${JSON.stringify(record)}\n`, { mode: 0o600 })
  } catch {
    // Auditing must never break delivery.
  }
}

export function describeNotify(result) {
  if (result.ok && result.dryRun) {
    return `notify (dry run): ${result.connector}, ${result.chunks} chunk(s), nothing sent`
  }
  if (result.ok && result.deduped) return 'notify: deduplicated (same message within 5 minutes)'
  if (result.ok) return `notify: sent via ${result.connector} in ${result.chunks} chunk(s)`
  // The secret-stage error already carries the exact command; do not repeat it.
  return `notify: failed at ${result.stage}: ${result.error}`
}