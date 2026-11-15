import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { INTENTS, OP, createSession, describeSessionEvent, fetchGatewayUrl } from '../src/connectors/qq-gateway.js'

/** A fake transport that records what the session sent. */
function fakeSocket() {
  const socket = new EventEmitter()
  const sent = []
  socket.sent = sent
  socket.send = (raw) => {
    sent.push(JSON.parse(raw))
    return true
  }
  socket.close = (code, reason) => {
    socket.closed = { code, reason }
    socket.emit('close', { code, reason })
  }
  return socket
}

function harness({ token = 'tok', gatewayUrl = 'wss://gateway.example/ws' } = {}) {
  const socket = fakeSocket()
  const timers = []
  const session = createSession({
    appId: 'app',
    getToken: async () => token,
    fetchImpl: async (url) => {
      if (String(url).includes('/gateway')) {
        return { ok: true, status: 200, json: async () => ({ url: gatewayUrl }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    },
    connect: () => socket,
    // Run scheduled work immediately so the test does not depend on wall time.
    setTimeoutImpl: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimeoutImpl: () => {},
    now: () => 0,
    random: () => 1,
  })
  return { session, socket, timers }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('fetchGatewayUrl refuses a bad response', async () => {
  await assert.rejects(
    () => fetchGatewayUrl({ token: 't', fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /HTTP 500/,
  )
  await assert.rejects(
    () => fetchGatewayUrl({ token: 't', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }),
    /no url/,
  )
})

test('hello triggers identify with the group and C2C intent', async () => {
  const { session, socket } = harness()
  await session.start()
  socket.emit('message', JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 30_000 } }))
  await tick()
  const identify = socket.sent.find((frame) => frame.op === OP.IDENTIFY)
  assert.ok(identify, 'identify frame should be sent')
  assert.equal(identify.d.intents, INTENTS.GROUP_AND_C2C_EVENT)
  assert.match(identify.d.token, /^QQBot /)
})

test('READY records the session id and emits ready once', async () => {
  const { session, socket } = harness()
  const seen = []
  session.on('ready', (info) => seen.push(info))
  await session.start()
  socket.emit('message', JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 30_000 } }))
  await tick()
  socket.emit('message', JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1' } }))
  socket.emit('message', JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 2, d: { session_id: 'sess-1' } }))
  assert.equal(seen.length, 1)
  assert.equal(session.state().sessionId, 'sess-1')
  assert.equal(session.state().ready, true)
})

test('dispatch events for C2C and group messages reach onEvent', async () => {
  const socket = fakeSocket()
  const events = []
  const session = createSession({
    appId: 'app',
    getToken: async () => 'tok',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ url: 'wss://x' }) }),
    connect: () => socket,
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
    onEvent: (event) => events.push(event),
  })
  await session.start()
  socket.emit('message', JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 30_000 } }))
  await tick()
  socket.emit('message', JSON.stringify({ op: OP.DISPATCH, t: 'C2C_MESSAGE_CREATE', s: 3, d: { id: 'm1', content: '/status', author: { user_openid: 'u1' } } }))
  socket.emit('message', JSON.stringify({ op: OP.DISPATCH, t: 'GROUP_AT_MESSAGE_CREATE', s: 4, d: { id: 'm2', content: '/help', group_openid: 'g1', author: { member_openid: 'u1' } } }))
  socket.emit('message', JSON.stringify({ op: OP.DISPATCH, t: 'GROUP_MESSAGE_CREATE', s: 5, d: {} }))
  assert.deepEqual(events.map((event) => event.type), ['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'])
})

test('heartbeat is scheduled with the interval from hello', async () => {
  const { session, socket, timers } = harness()
  await session.start()
  socket.emit('message', JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 12_345 } }))
  await tick()
  assert.ok(timers.some((timer) => timer.ms === 12_345), 'heartbeat should use the server interval')
})

test('server reconnect request closes the socket and schedules a retry', async () => {
  const { session, socket, timers } = harness()
  await session.start()
  socket.emit('message', JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 30_000 } }))
  await tick()
  socket.emit('message', JSON.stringify({ op: OP.RECONNECT }))
  await tick()
  assert.equal(socket.closed.code, 4001)
  assert.ok(timers.some((timer) => timer.ms > 0), 'a reconnect should be scheduled')
})

test('a fatal close code stops the session instead of retrying', async () => {
  const { session, socket } = harness()
  const stops = []
  session.on('stop', (info) => stops.push(info))
  await session.start()
  socket.emit('close', { code: 4004, reason: 'bad token' })
  await tick()
  assert.equal(session.state().stopped, true)
  assert.equal(stops.length, 1)
})

test('invalid session drops resume state', async () => {
  const { session, socket } = harness()
  await session.start()
  socket.emit('message', JSON.stringify({ op: OP.HELLO, d: { heartbeat_interval: 30_000 } }))
  await tick()
  socket.emit('message', JSON.stringify({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-9' } }))
  socket.emit('message', JSON.stringify({ op: OP.INVALID_SESSION }))
  await tick()
  assert.equal(session.state().sessionId, null)
})

test('describeSessionEvent normalises C2C and group payloads', () => {
  const c2c = describeSessionEvent({ type: 'C2C_MESSAGE_CREATE', data: { id: 'm', content: '/help', author: { user_openid: 'u' } } })
  assert.deepEqual(c2c, { kind: 'c2c', openid: 'u', content: '/help', id: 'm' })
  const group = describeSessionEvent({
    type: 'GROUP_AT_MESSAGE_CREATE',
    data: { id: 'm2', content: '/status', group_openid: 'g', author: { member_openid: 'u2' } },
  })
  assert.equal(group.kind, 'group')
  assert.equal(group.groupOpenid, 'g')
  assert.equal(group.openid, 'u2')
})
