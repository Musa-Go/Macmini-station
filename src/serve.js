/**
 * `station serve` — QQ inbound commands over the official gateway (M3.4).
 *
 * Design rules (docs/CONNECTORS.md §5):
 *   - strictly read-only: `/status`, `/backup status`, `/help`; anything that
 *     would change the machine is refused and pointed at the controlled jobs path;
 *   - only allowlisted openids get any answer at all (silence otherwise);
 *   - replies are passive (they carry the inbound message id) and respect QQ's
 *     per-message reply budget: 4 for C2C, 5 for group;
 *   - every handled message is audited without its content.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './state.js'
import { describeSessionEvent, createSession } from './connectors/qq-gateway.js'
import { fetchAccessToken, sendReply } from './connectors/qq.js'
import { readKeychain } from './notify.js'
import { runDoctor, summarizeChecks } from './doctor.js'
import { configPath } from './config.js'

export const REPLY_BUDGET = { c2c: 4, group: 5 }
export const COMMANDS = ['/help', '/status', '/backup status']

export function auditFile(cwd) {
  return join(stateDir(cwd), 'serve.log')
}

export function audit(cwd, record) {
  try {
    mkdirSync(stateDir(cwd), { recursive: true })
    appendFileSync(auditFile(cwd), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 })
  } catch {
    // Auditing must never break serving.
  }
}

/** Parse a command string into a canonical command name. */
export function parseCommand(text) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/<@!?\d+>/g, '') // strip a mention prefix
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (normalized === '' ) return null
  if (normalized.startsWith('/status')) return '/status'
  if (normalized.startsWith('/backup status') || normalized.startsWith('/backup')) return '/backup status'
  if (normalized.startsWith('/help')) return '/help'
  return normalized.startsWith('/') ? normalized : null
}

export function helpText() {
  return ['可用指令（只读）：', '/status  机器与能力摘要', '/backup status  最近一次备份与校验结果', '/help  本说明'].join('\n')
}

/**
 * Build the answer for one command. `deps` supplies the data so tests can answer
 * without touching the machine.
 */
export async function answerCommand({ command, cwd, root, deps = {} }) {
  if (command === '/help' || command === null) return helpText()

  if (command === '/status') {
    const checks = (deps.runDoctor ?? runDoctor)({ cwd, root: root ?? deps.root })
    const summary = summarizeChecks(checks)
    const critical = checks.filter((check) => check.status === 'critical').map((check) => check.title)
    const warn = checks.filter((check) => check.status === 'warn').map((check) => check.title)
    const lines = [
      `机器：ok ${summary.ok} · warn ${summary.warn} · critical ${summary.critical} · unknown ${summary.unknown}`,
    ]
    if (critical.length > 0) lines.push(`critical：${critical.join('、')}`)
    if (warn.length > 0) lines.push(`warn：${warn.slice(0, 5).join('、')}${warn.length > 5 ? ' …' : ''}`)
    if (critical.length === 0 && warn.length === 0) lines.push('全部正常')
    return lines.join('\n')
  }

  if (command === '/backup status') {
    const readState = deps.readBackupState ?? defaultBackupState
    const state = readState({ cwd })
    if (!state) return '尚无备份记录：先在本机运行 station backup'
    const age = typeof state.ageHours === 'number' ? `${state.ageHours.toFixed(1)} 小时前` : '时间未知'
    const lines = [`最近备份：${age}`, `结果：${state.ok ? '成功' : '失败'}`, `目标：${state.target ?? '未知'}`]
    if (state.detail) lines.push(state.detail)
    return lines.join('\n')
  }

  return ['这个指令不支持。', '写操作请走本机的受控任务入口（station worktree），QQ 只做查询。', '', helpText()].join('\n')
}

function defaultBackupState({ cwd }) {
  const path = join(stateDir(cwd), 'backup-state.json')
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const at = Date.parse(parsed.at ?? '')
    const ageHours = Number.isFinite(at) ? (Date.now() - at) / 3_600_000 : undefined
    return { ...parsed, ageHours }
  } catch {
    return null
  }
}

export function isAllowed({ config, openid }) {
  const allowFrom = config.notifications?.qq?.allowFrom
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false
  return allowFrom.map((entry) => String(entry).trim()).includes(String(openid).trim())
}

/**
 * Handle one inbound event: filter, answer, reply passively, audit.
 * Returns a structured result so tests can assert without a socket.
 */
export async function handleInbound({ event, cwd, root, config, deps = {} }) {
  const info = describeSessionEvent(event)
  const openid = info.openid
  const allowed = isAllowed({ config, openid })
  if (!allowed) {
    audit(cwd, { kind: info.kind, status: 'ignored', reason: 'not in allowFrom', msgId: info.id })
    return { ok: false, stage: 'allowlist', replied: false }
  }

  const command = parseCommand(info.content)
  const reply = await answerCommand({ command, cwd, root, deps })

  const target = info.kind === 'group' ? { kind: 'group', groupOpenid: info.groupOpenid } : { kind: 'c2c', openid }
  const budget = REPLY_BUDGET[info.kind === 'group' ? 'group' : 'c2c']
  if (budget < 1) {
    audit(cwd, { kind: info.kind, status: 'no-budget', msgId: info.id })
    return { ok: false, stage: 'budget', replied: false }
  }

  const deliver = deps.sendReply ?? sendReply
  const token = deps.token ?? (await (deps.getToken ?? defaultTokenProvider(config))())
  try {
    await deliver({
      appId: config.notifications?.qq?.appId,
      token,
      target,
      content: reply,
      msgId: info.id,
      msgSeq: 1,
      fetchImpl: deps.fetchImpl,
    })
    audit(cwd, { kind: info.kind, status: 'replied', command: command ?? 'help', msgId: info.id })
    return { ok: true, command: command ?? '/help', replied: true, kind: info.kind }
  } catch (error) {
    audit(cwd, { kind: info.kind, status: 'reply-failed', command: command ?? 'help', msgId: info.id })
    return { ok: false, stage: 'reply', error: String(error?.message ?? error), replied: false }
  }
}

function defaultTokenProvider(config) {
  return async () => {
    const ref = config.notifications?.qq?.secretRef
    if (!ref) throw new Error('notifications.qq.secretRef is required for inbound commands')
    const secret = readKeychain({ ref })
    if (!secret.ok) throw new Error(secret.error)
    const appId = config.notifications?.qq?.appId
    if (!appId) throw new Error('notifications.qq.appId is required for inbound commands')
    const { token } = await fetchAccessToken({ appId, secret: secret.secret, fetchImpl: globalThis.fetch })
    return token
  }
}

/** Pre-flight: is the machine configured well enough to serve? */
export function checkServeReadiness({ config, cwd }) {
  const problems = []
  const qq = config.notifications?.qq ?? {}
  if (config.notifications?.primary !== 'qq' && !config.notifications?.qq) {
    problems.push('notifications.qq is not configured; inbound commands need appId + secretRef')
  }
  if (!qq.appId) problems.push('notifications.qq.appId is missing')
  if (!qq.secretRef) problems.push('notifications.qq.secretRef is missing')
  if (!Array.isArray(qq.allowFrom) || qq.allowFrom.length === 0) {
    problems.push('notifications.qq.allowFrom is empty; without it every message would be ignored')
  }
  if (!existsSync(configPath({ cwd }))) {
    problems.push('station.json not found; run `station init` first')
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Run the long-lived service. Resolves when the session stops.
 */
export async function serve({ cwd, root, config, deps = {} }) {
  const readiness = checkServeReadiness({ config, cwd })
  if (!readiness.ok) {
    return { ok: false, stage: 'config', problems: readiness.problems }
  }

  const log = deps.logger ?? (() => {})
  const session = createSession({
    appId: config.notifications.qq.appId,
    getToken: deps.getToken ?? defaultTokenProvider(config),
    connect: deps.connect,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    logger: log,
    onEvent: (event) => {
      handleInbound({ event, cwd, root, config, deps }).catch((error) => {
        log('inbound handler failed', { error: String(error?.message ?? error) })
      })
    },
  })

  if (deps.stopSignal) {
    deps.stopSignal.then(() => session.stop())
  }

  audit(cwd, { status: 'serve-start' })
  await session.start()
  return session
}

export function describeReadiness(result) {
  if (result.ok) return 'serve: configuration looks ready'
  return ['serve: cannot start', ...result.problems.map((problem) => `  - ${problem}`)].join('\n')
}