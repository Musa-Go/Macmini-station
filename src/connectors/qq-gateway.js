/**
 * QQ official-bot gateway session (M3.4).
 *
 * The gateway is a long-lived WebSocket: the server sends `op=10` with a heartbeat
 * interval, the client answers with `op=2` IDENTIFY (or `op=6` RESUME after a drop)
 * and then receives dispatch events (`op=0`, `t=C2C_MESSAGE_CREATE` etc.).
 *
 * Everything here is injectable (`connect`, `fetchImpl`, timers) so tests drive a
 * fake transport and never touch the network.
 */

import { EventEmitter } from 'node:events'

export const INTENTS = {
  GROUP_AND_C2C_EVENT: 1 << 25,
}

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
}

export const GATEWAY_URL = 'https://api.sgroup.qq.com/gateway'

/**
 * Emitting 'error' with no listener would throw and kill the process, so a
 * library-level session only reports when somebody is listening.
 */
function reportError(emitter, error) {
  if (emitter.listenerCount('error') > 0) reportError(emitter, error)
}

export function tokenType(token) {
  return `QQBot ${token}`
}

/**
 * Ask the API for the gateway URL. QQ returns a wss URL; we never cache it past a
 * reconnect because the endpoint can change.
 */
export async function fetchGatewayUrl({ token, fetchImpl, signal }) {
  const response = await fetchImpl(GATEWAY_URL, {
    method: 'GET',
    headers: { authorization: tokenType(token) },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error(`gateway discovery failed: HTTP ${response.status}`)
  const payload = await response.json()
  if (typeof payload?.url !== 'string' || payload.url === '') throw new Error('gateway discovery returned no url')
  return payload.url
}

/**
 * Manage one gateway connection. Emits:
 *   'ready'   — IDENTIFY/RESUME accepted (first time only for `ready`)
 *   'event'   — { type, data } for dispatch frames we care about
 *   'error'   — transport or protocol problem (does not stop the session)
 *   'stop'    — session closed for good
 */
export function createSession({
  appId,
  getToken,
  connect,
  fetchImpl,
  logger = () => {},
  onEvent = () => {},
  heartbeatGraceMs = 45_000,
  maxReconnectDelayMs = 60_000,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  random = Math.random,
}) {
  const emitter = new EventEmitter()
  let socket = null
  let heartbeatTimer = null
  let graceTimer = null
  let attempt = 0
  let sessionId = null
  let seq = null
  let stopped = false
  let ready = false
  let heartbeatIntervalMs = 30_000
  let lastAck = 0

  const log = (message, extra) => logger(message, extra)

  function clearTimers() {
    if (heartbeatTimer) clearTimeoutImpl(heartbeatTimer)
    if (graceTimer) clearTimeoutImpl(graceTimer)
    heartbeatTimer = null
    graceTimer = null
  }

  function scheduleHeartbeat() {
    if (heartbeatTimer) clearTimeoutImpl(heartbeatTimer)
    heartbeatTimer = setTimeoutImpl(() => {
      if (!socket) return
      send({ op: OP.HEARTBEAT, d: seq })
      if (now() - lastAck > heartbeatIntervalMs + heartbeatGraceMs) {
        log('heartbeat ack missing; forcing reconnect')
        socket.close(4000, 'heartbeat timeout')
        handleClose({ code: 4000, reason: 'heartbeat timeout' })
        return
      }
      scheduleHeartbeat()
    }, heartbeatIntervalMs)
  }

  function send(payload) {
    if (!socket || typeof socket.send !== 'function') return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch (error) {
      log('send failed', { error: String(error?.message ?? error) })
      return false
    }
  }

  async function identify() {
    const token = await getToken()
    send({
      op: OP.IDENTIFY,
      d: {
        token: tokenType(token),
        intents: INTENTS.GROUP_AND_C2C_EVENT,
        shard: [0, 1],
        properties: { $os: 'macos', $browser: 'macmini-station', $device: 'macmini-station' },
      },
    })
  }

  function resume() {
    if (!sessionId || seq === null) {
      identify().catch((error) => reportError(emitter, error))
      return
    }
    log('resuming session', { sessionId })
    getToken()
      .then((token) => send({ op: OP.RESUME, d: { token: tokenType(token), session_id: sessionId, seq } }))
      .catch((error) => reportError(emitter, error))
  }

  function handleMessage(raw) {
    let payload
    try {
      payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
    } catch {
      emitter.emit('error', new Error('gateway sent a non-JSON frame'))
      return
    }
    if (typeof payload?.s === 'number') seq = payload.s

    switch (payload.op) {
      case OP.HELLO: {
        heartbeatIntervalMs = Number(payload.d?.heartbeat_interval ?? 30_000)
        lastAck = now()
        if (sessionId && seq !== null) resume()
        else identify().catch((error) => reportError(emitter, error))
        scheduleHeartbeat()
        return
      }
      case OP.HEARTBEAT_ACK:
        lastAck = now()
        return
      case OP.RECONNECT:
        log('server asked for a reconnect')
        socket?.close(4001, 'reconnect requested')
        handleClose({ code: 4001, reason: 'reconnect requested' })
        return
      case OP.INVALID_SESSION:
        log('session invalidated; dropping resume state')
        sessionId = null
        seq = null
        socket?.close(4002, 'invalid session')
        handleClose({ code: 4002, reason: 'invalid session' })
        return
      case OP.DISPATCH: {
        if (payload.t === 'READY') {
          sessionId = payload.d?.session_id ?? null
          if (!ready) {
            ready = true
            emitter.emit('ready', { sessionId, user: payload.d?.user ?? null })
          }
          return
        }
        if (payload.t === 'RESUMED') {
          log('session resumed')
          return
        }
        const handled = ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE']
        if (handled.includes(payload.t)) {
          onEvent({ type: payload.t, data: payload.d, id: payload.id })
        }
        return
      }
      default:
        return
    }
  }

  let reconnectTimer = null
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return
    attempt += 1
    const base = Math.min(maxReconnectDelayMs, 1000 * 2 ** Math.min(attempt - 1, 6))
    const delay = Math.round(base * (0.5 + random() / 2))
    log('scheduling reconnect', { attempt, delay })
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null
      start().catch((error) => reportError(emitter, error))
    }, delay)
  }

  function handleClose({ code, reason }) {
    clearTimers()
    socket = null
    if (stopped) {
      emitter.emit('stop', { code, reason })
      return
    }
    // 4004/4010-4014 are authentication problems: retrying cannot fix them.
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
      stopped = true
      reportError(emitter, new Error(`gateway closed with a fatal code ${code}: ${reason}`))
      emitter.emit('stop', { code, reason })
      return
    }
    if ([4900, 4914, 4915].includes(code)) {
      sessionId = null
      seq = null
    }
    scheduleReconnect()
  }

  async function start() {
    if (stopped) return
    if (socket) return
    try {
      const token = await getToken()
      const url = await fetchGatewayUrl({ token, fetchImpl })
      const ws = connect(url, { headers: { 'User-Agent': 'macmini-station' } })
      socket = ws
      ws.on('message', handleMessage)
      ws.on('error', (error) => {
        log('socket error', { error: String(error?.message ?? error) })
        reportError(emitter, error)
      })
      ws.on('close', (info) => {
        if (socket !== ws) return
        handleClose(info ?? { code: 1006, reason: 'closed' })
      })
      ws.on('open', () => {
        attempt = 0
        log('socket open, awaiting hello')
      })
    } catch (error) {
      reportError(emitter, error)
      handleClose({ code: 1006, reason: String(error?.message ?? error) })
    }
  }

  function stop() {
    stopped = true
    clearTimers()
    if (reconnectTimer) clearTimeoutImpl(reconnectTimer)
    if (socket) {
      try {
        socket.close(1000, 'shutdown')
      } catch {}
      socket = null
    }
    emitter.emit('stop', { code: 1000, reason: 'shutdown' })
  }

  emitter.start = start
  emitter.stop = stop
  emitter.state = () => ({ sessionId, seq, ready, attempt, stopped })
  return emitter
}

export function describeSessionEvent(event) {
  const data = event?.data ?? {}
  if (event?.type === 'GROUP_AT_MESSAGE_CREATE') {
    return { kind: 'group', groupOpenid: data.group_openid, openid: data.author?.member_openid, content: data.content, id: data.id }
  }
  return { kind: 'c2c', openid: data.author?.user_openid, content: data.content, id: data.id }
}