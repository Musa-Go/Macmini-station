import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameParser, acceptKey, encodeFrame } from '../src/ws.js'

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})

test('client frames are masked and round-trip through the parser', () => {
  for (const text of ['', 'hello', '中文消息', 'x'.repeat(200), 'y'.repeat(70_000)]) {
    const frame = encodeFrame({ opcode: 1, payload: Buffer.from(text) })
    assert.equal(frame[1] & 0x80, 0x80, 'client frames must set the mask bit')
    const frames = new FrameParser().push(frame)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].opcode, 1)
    assert.equal(frames[0].payload.toString('utf8'), text)
  }
})

test('a frame split across chunks is assembled', () => {
  const frame = encodeFrame({ opcode: 1, payload: Buffer.from('split me') })
  const parser = new FrameParser()
  assert.deepEqual(parser.push(frame.subarray(0, 3)), [])
  assert.deepEqual(parser.push(frame.subarray(3, 7)), [])
  const frames = parser.push(frame.subarray(7))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].payload.toString(), 'split me')
})

test('fragmented messages are reassembled into one frame', () => {
  const head = encodeFrame({ opcode: 1, payload: Buffer.from('he'), fin: false })
  const tail = encodeFrame({ opcode: 0, payload: Buffer.from('llo'), fin: true })
  const frames = new FrameParser().push(Buffer.concat([head, tail]))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].payload.toString(), 'hello')
  assert.equal(frames[0].opcode, 1)
})

test('multiple frames in one chunk are all returned', () => {
  const chunk = Buffer.concat([
    encodeFrame({ opcode: 1, payload: Buffer.from('a') }),
    encodeFrame({ opcode: 9, payload: Buffer.from('ping') }),
    encodeFrame({ opcode: 1, payload: Buffer.from('b') }),
  ])
  const frames = new FrameParser().push(chunk)
  assert.deepEqual(frames.map((frame) => frame.opcode), [1, 9, 1])
})

test('an oversized frame is rejected instead of buffered', () => {
  const parser = new FrameParser({ maxBytes: 10 })
  const frame = encodeFrame({ opcode: 1, payload: Buffer.from('x'.repeat(20)) })
  assert.throws(() => parser.push(frame), /too large/)
})
