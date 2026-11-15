import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, configPath } from '../src/config.js'
import {
  answerCommand,
  auditFile,
  checkServeReadiness,
  describeReadiness,
  handleInbound,
  helpText,
  isAllowed,
  parseCommand,
  REPLY_BUDGET,
} from '../src/serve.js'

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'station-serve-'))
  const config = defaultConfig()
  config.notifications = {
    primary: 'qq',
    qq: { appId: '102880683', secretRef: 'station.qq.appSecret', allowFrom: ['openid-owner'] },
    inbound: { enabled: true },
  }
  writeFileSync(configPath({ cwd: dir }), JSON.stringify(config, null, 2))
  return { dir, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function c2cEvent(content, openid = 'openid-owner') {
  return { type: 'C2C_MESSAGE_CREATE', data: { id: 'msg-1', content, author: { user_openid: openid } } }
}

test('parseCommand normalises mentions and whitespace', () => {
  assert.equal(parseCommand('/status'), '/status')
  assert.equal(parseCommand('  /STATUS  '), '/status')
  assert.equal(parseCommand('<@!123456> /help'), '/help')
  assert.equal(parseCommand('/backup status'), '/backup status')
  assert.equal(parseCommand('/backup'), '/backup status')
  assert.equal(parseCommand('hello'), null)
  assert.equal(parseCommand(''), null)
  assert.equal(parseCommand('/rm -rf /'), '/rm -rf /')
})

test('help advertises only read-only commands', () => {
  const text = helpText()
  assert.match(text, /\/status/)
  assert.match(text, /\/backup status/)
  assert.match(text, /\/help/)
  assert.match(text, /只读/)
})

test('only allowlisted openids are accepted', () => {
  const config = defaultConfig()
  config.notifications = { primary: 'qq', qq: { appId: 'a', secretRef: 'r', allowFrom: ['allowed'] } }
  assert.equal(isAllowed({ config, openid: 'allowed' }), true)
  assert.equal(isAllowed({ config, openid: 'stranger' }), false)
  const empty = defaultConfig()
  assert.equal(isAllowed({ config: empty, openid: 'anyone' }), false)
})

test('an inbound message from a stranger is ignored without any reply', async () => {
  const s = sandbox()
  try {
    const calls = []
    const result = await handleInbound({
      event: c2cEvent('/status', 'stranger'),
      cwd: s.dir,
      config: s.config,
      deps: { sendReply: async (...args) => calls.push(args), token: 'tok' },
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'allowlist')
    assert.equal(calls.length, 0)
    assert.match(readFileSync(auditFile(s.dir), 'utf8'), /not in allowFrom/)
  } finally {
    s.cleanup()
  }
})

test('a read-only command is answered with a passive reply carrying the message id', async () => {
  const s = sandbox()
  try {
    const calls = []
    const result = await handleInbound({
      event: c2cEvent('/status'),
      cwd: s.dir,
      config: s.config,
      deps: {
        token: 'tok',
        sendReply: async (args) => {
          calls.push(args)
          return { ok: true }
        },
        runDoctor: () => [
          { id: 'node', title: 'Node.js', status: 'ok', detail: 'v22' },
          { id: 'restic', title: 'restic', status: 'warn', detail: 'missing' },
        ],
      },
    })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].msgId, 'msg-1')
    assert.equal(calls[0].msgSeq, 1)
    assert.equal(calls[0].target.kind, 'c2c')
    assert.match(calls[0].content, /warn 1/)
    assert.match(readFileSync(auditFile(s.dir), 'utf8'), /"status":"replied"/)
  } finally {
    s.cleanup()
  }
})

test('a group message replies to the group with the group reply budget', async () => {
  const s = sandbox()
  try {
    const calls = []
    const result = await handleInbound({
      event: { type: 'GROUP_AT_MESSAGE_CREATE', data: { id: 'g-1', content: '/help', group_openid: 'group-1', author: { member_openid: 'openid-owner' } } },
      cwd: s.dir,
      config: s.config,
      deps: { token: 'tok', sendReply: async (args) => calls.push(args) },
    })
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'group')
    assert.deepEqual(calls[0].target, { kind: 'group', groupOpenid: 'group-1' })
    assert.equal(REPLY_BUDGET.group, 5)
  } finally {
    s.cleanup()
  }
})

test('a write-looking command is refused and points at the controlled path', async () => {
  const s = sandbox()
  try {
    const answer = await answerCommand({ command: '/deploy now', cwd: s.dir })
    assert.match(answer, /不支持/)
    assert.match(answer, /worktree/)
  } finally {
    s.cleanup()
  }
})

test('backup status answers when there is no record and when there is one', async () => {
  const s = sandbox()
  try {
    const none = await answerCommand({ command: '/backup status', cwd: s.dir })
    assert.match(none, /尚无备份记录/)

    const one = await answerCommand({
      command: '/backup status',
      cwd: s.dir,
      deps: { readBackupState: () => ({ ok: true, target: '/tmp/backups', ageHours: 2.5, at: new Date().toISOString() }) },
    })
    assert.match(one, /2\.5 小时前/)
    assert.match(one, /成功/)
  } finally {
    s.cleanup()
  }
})

test('a reply failure is reported and audited', async () => {
  const s = sandbox()
  try {
    const result = await handleInbound({
      event: c2cEvent('/help'),
      cwd: s.dir,
      config: s.config,
      deps: {
        token: 'tok',
        sendReply: async () => {
          throw new Error('HTTP 400')
        },
      },
    })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'reply')
    assert.match(readFileSync(auditFile(s.dir), 'utf8'), /reply-failed/)
  } finally {
    s.cleanup()
  }
})

test('readiness reports every missing piece of the QQ configuration', () => {
  const empty = checkServeReadiness({ config: defaultConfig(), cwd: '/tmp' })
  assert.equal(empty.ok, false)
  assert.ok(empty.problems.some((problem) => /appId/.test(problem)))
  assert.ok(empty.problems.some((problem) => /allowFrom/.test(problem)))
  assert.match(describeReadiness(empty), /cannot start/)

  const s = sandbox()
  try {
    const ready = checkServeReadiness({ config: s.config, cwd: s.dir })
    assert.equal(ready.ok, true, JSON.stringify(ready.problems))
  } finally {
    s.cleanup()
  }
})

test('audit records never contain the message body', async () => {
  const s = sandbox()
  try {
    await handleInbound({
      event: c2cEvent('/status secret-token-should-not-appear'),
      cwd: s.dir,
      config: s.config,
      deps: { token: 'tok', sendReply: async () => ({ ok: true }), runDoctor: () => [] },
    })
    const log = readFileSync(auditFile(s.dir), 'utf8')
    assert.ok(!log.includes('secret-token-should-not-appear'), 'audit must not store message content')
  } finally {
    s.cleanup()
  }
})
