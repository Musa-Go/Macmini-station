/**
 * Minimal WebSocket client (RFC 6455), dependency-free.
 *
 * The toolkit supports Node 20, where a global `WebSocket` is not guaranteed, so
 * the QQ gateway needs its own client. Only what the gateway actually uses is
 * implemented: text frames, fragmentation, ping/pong and close. Binary payloads
 * are surfaced as Buffers but never sent.
 */

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

export function encodeFrame({ opcode = 1, payload = Buffer.alloc(0), fin = true, mask = true }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f)
  if (!mask) return Buffer.concat([header, body])

  header[1] |= 0x80
  const key = randomBytes(4)
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = body[index] ^ key[index % 4]
  }
  return Buffer.concat([header, key, masked])
}

/** Incremental parser: feeds socket chunks, returns complete frames. */
export class FrameParser {
  constructor({ maxBytes = MAX_FRAME_BYTES } = {}) {
    this.buffer = Buffer.alloc(0)
    this.maxBytes = maxBytes
    this.fragments = []
    this.fragmentOpcode = null
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames = []
    for (;;) {
      const before = this.buffer.length
      const frame = this.#parseOne()
      if (frame) {
        frames.push(frame)
        continue
      }
      // `null` means either "need more bytes" or "this was a fragment start that
      // was absorbed". Continue only when bytes were actually consumed.
      if (this.buffer.length === before) break
    }
    return frames
  }

  #parseOne() {
    const buffer = this.buffer
    if (buffer.length < 2) return null
    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(this.maxBytes)) throw new Error(`websocket frame too large: ${big}`)
      length = Number(big)
      offset += 8
    }
    if (length > this.maxBytes) throw new Error(`websocket frame too large: ${length}`)

    let maskKey = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return null

    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (maskKey) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= maskKey[index % 4]
      }
    }
    this.buffer = buffer.subarray(offset + length)

    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) throw new Error('unexpected continuation frame')
      this.fragments.push(payload)
      if (!fin) return null
      const full = Buffer.concat(this.fragments)
      const result = { opcode: this.fragmentOpcode, payload: full, fin: true }
      this.fragments = []
      this.fragmentOpcode = null
      return result
    }
    if (!fin) {
      this.fragmentOpcode = opcode
      this.fragments = [payload]
      return null
    }
    return { opcode, payload, fin: true }
  }
}

/**
 * Open a WebSocket and return an EventEmitter with `send` and `close`.
 * Events: `open`, `message` (string|Buffer), `close` ({code, reason}), `error`.
 */
export function connect(url, { headers = {}, timeoutMs = 15_000 } = {}) {
  const emitter = new EventEmitter()
  const target = new URL(url)
  const secure = target.protocol === 'wss:'
  if (!secure && target.protocol !== 'ws:') throw new Error(`unsupported websocket scheme: ${target.protocol}`)

  const key = randomBytes(16).toString('base64')
  const request = secure ? httpsRequest : httpRequest
  const req = request({
    host: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    timeout: timeoutMs,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      'User-Agent': 'macmini-station',
      ...headers,
    },
  })

  let settled = false
  const fail = (error) => {
    if (settled) return
    settled = true
    emitter.emit('error', error)
    emitter.emit('close', { code: 1006, reason: String(error?.message ?? error) })
  }

  req.on('upgrade', (response, socket) => {
    const expected = acceptKey(key)
    if (response.headers['sec-websocket-accept'] !== expected) {
      socket.destroy()
      fail(new Error('websocket handshake failed: bad accept key'))
      return
    }
    settled = true
    const parser = new FrameParser()
    emitter.send = (text) => {
      if (socket.destroyed) return false
      socket.write(encodeFrame({ opcode: 1, payload: Buffer.from(String(text), 'utf8') }))
      return true
    }
    emitter.close = (code = 1000, reason = '') => {
      if (socket.destroyed) return
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      try {
        socket.write(encodeFrame({ opcode: 8, payload }))
      } catch {}
      socket.end()
    }
    socket.on('data', (chunk) => {
      let frames
      try {
        frames = parser.push(chunk)
      } catch (error) {
        fail(error)
        socket.destroy()
        return
      }
      for (const frame of frames) {
        if (frame.opcode === 1) emitter.emit('message', frame.payload.toString('utf8'))
        else if (frame.opcode === 2) emitter.emit('message', frame.payload)
        else if (frame.opcode === 8) {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005
          const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
          socket.end()
          emitter.emit('close', { code, reason })
        } else if (frame.opcode === 9) {
          try {
            socket.write(encodeFrame({ opcode: 10, payload: frame.payload }))
          } catch {}
        }
      }
    })
    socket.on('close', () => emitter.emit('close', { code: 1000, reason: 'socket closed' }))
    socket.on('error', (error) => fail(error))
    req.setTimeout(0)
    emitter.emit('open')
  })

  req.on('response', (response) => {
    response.resume()
    fail(new Error(`websocket handshake rejected with HTTP ${response.statusCode}`))
  })
  req.on('timeout', () => {
    req.destroy()
    fail(new Error('websocket handshake timed out'))
  })
  req.on('error', (error) => fail(error))
  req.end()

  emitter.request = req
  return emitter
}

export class GatewayError extends Error {
  constructor(stage, message) {
    super(message)
    this.name = 'GatewayError'
    this.stage = stage
  }
}