/**
 * `station apply` / `verify` / `rollback`.
 *
 * Hard rules baked into this module:
 *   1. apply never starts a service and never registers a daemon — it only
 *      creates directories and writes the journal;
 *   2. apply is idempotent: existing paths are reported, not re-created;
 *   3. rollback removes only paths recorded as created by this tool, and only
 *      while they are still empty (directories) or unchanged (files).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig, configPath } from './config.js'
import { expandHome } from './probes.js'
import {
  configHash,
  findJournal,
  latestJournal,
  listJournals,
  newJournalId,
  stateDir,
  writeJournal,
  writeRollbackRecord,
} from './state.js'

/**
 * Paths a rollback is ever allowed to touch: the state directory and the
 * configured backup target. Anything else in a journal is ignored, so a forged
 * entry cannot reach the rest of the filesystem.
 */
export function rollbackRoots({ cwd, config }) {
  const roots = [resolve(stateDir(cwd))]
  const target = config?.storage?.backup?.target?.path
  if (typeof target === 'string' && target.trim() !== '') roots.push(resolve(expandHome(target)))
  return roots
}

function isWithin(path, roots) {
  const resolved = resolve(path)
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`))
}

function fileHash(path) {
  const content = readFileSync(path)
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Compute the actions apply would take. Pure: no filesystem writes.
 */
export function planApply({ config, cwd }) {
  const actions = []
  const state = stateDir(cwd)

  if (!existsSync(state)) {
    actions.push({
      path: state,
      kind: 'dir',
      action: 'create',
      reason: 'journal and local state',
      protected: true,
    })
  }

  const backup = config.storage?.backup
  if (backup?.enabled) {
    const type = backup.target?.type
    if (type === 'local' || type === 'external-disk') {
      const target = resolve(expandHome(backup.target?.path ?? ''))
      if (target && !existsSync(target)) {
        actions.push({ path: target, kind: 'dir', action: 'create', reason: `${type} backup target` })
      }
    }
  }

  return actions
}

/**
 * Apply the plan. With dryRun it reports the same actions without touching disk.
 */
export function apply({ cwd, dryRun = false, config }) {
  const effective = config ?? loadConfig({ cwd })

  if (!existsSync(configPath({ cwd }))) {
    throw new Error('station.json not found; run `station init` first')
  }

  const actions = planApply({ config: effective, cwd })
  const id = newJournalId()
  const created = []

  if (!dryRun) {
    for (const action of actions) {
      if (action.action !== 'create') continue
      if (existsSync(action.path)) continue
      mkdirSync(action.path, { recursive: true })
      created.push({ path: action.path, kind: action.kind, ...(action.protected ? { protected: true } : {}) })
    }
  }

  const journal = {
    id,
    createdAt: new Date().toISOString(),
    dryRun,
    configPath: configPath({ cwd }),
    configHash: configHash(effective),
    created,
    actions,
  }

  if (!dryRun) writeJournal(cwd, journal)

  return { id, dryRun, actions, created, journal }
}

/**
 * Re-check the applied state without changing anything.
 */
export function verify({ cwd, config }) {
  const checks = []
  const path = configPath({ cwd })

  if (!existsSync(path)) {
    checks.push({ id: 'config', status: 'critical', detail: 'station.json not found' })
    return { checks, ok: false }
  }

  let effective
  try {
    effective = config ?? loadConfig({ cwd })
    checks.push({ id: 'config', status: 'ok', detail: 'station.json valid' })
  } catch (error) {
    checks.push({ id: 'config', status: 'critical', detail: String(error.message ?? error) })
    return { checks, ok: false }
  }

  const state = stateDir(cwd)
  checks.push({
    id: 'state-dir',
    status: existsSync(state) ? 'ok' : 'warn',
    detail: existsSync(state) ? state : 'missing; run `station apply`',
  })

  const backup = effective.storage?.backup
  if (backup?.enabled && ['local', 'external-disk'].includes(backup.target?.type)) {
    const target = resolve(expandHome(backup.target?.path ?? ''))
    checks.push({
      id: 'backup-target',
      status: existsSync(target) ? 'ok' : 'warn',
      detail: existsSync(target) ? target : `missing: ${target}`,
    })
  }

  const allJournals = listJournals(cwd)
  const invalid = allJournals.filter((entry) => !entry.valid)
  if (invalid.length > 0) {
    checks.push({
      id: 'journal-integrity',
      status: 'critical',
      detail: `${invalid.length} journal(s) failed verification: ${invalid.map((entry) => `${entry.id} (${entry.problem})`).join('; ')}`,
      fix: 'those journals were modified outside this tool; rollback refuses them',
    })
  }
  const latest = latestJournal(cwd)
  if (latest && !latest.valid) {
    checks.push({
      id: 'journal',
      status: 'critical',
      detail: `${latest.id} signature problem: ${latest.problem}`,
      fix: 'the journal was modified by something other than this tool; rollback will refuse it',
    })
  } else if (!latest) {
    checks.push({ id: 'journal', status: 'warn', detail: 'no apply journal yet' })
  } else {
    const drift = latest.journal.created.filter((entry) => !existsSync(entry.path)).map((entry) => entry.path)
    checks.push({
      id: 'journal',
      status: drift.length === 0 ? 'ok' : 'warn',
      detail: drift.length === 0 ? `${latest.id} consistent` : `${latest.id} missing: ${drift.join(', ')}`,
    })
    const hashNow = configHash(effective)
    if (latest.journal.configHash !== hashNow) {
      checks.push({
        id: 'config-drift',
        status: 'warn',
        detail: `config changed since ${latest.id}; run \`station apply\` again`,
      })
    }
  }

  const ok = checks.every((check) => check.status === 'ok')
  return { checks, ok }
}

/**
 * Roll back a journal: remove only what it created, never user data.
 */
export function rollback({ cwd, to, dryRun = false, config }) {
  if (config === undefined) {
    try {
      config = loadConfig({ cwd })
    } catch {
      config = null
    }
  }
  const entry = to ? findJournal(cwd, to) : latestJournal(cwd)
  if (!entry) throw new Error(to ? `no journal with id ${to}` : 'no apply journal to roll back')

  const { journal } = entry
  if (!entry.valid) {
    throw new Error(`journal ${entry.id} failed verification (${entry.problem}); refusing to roll back from an untrusted journal`)
  }
  if (!Array.isArray(journal.created)) throw new Error(`journal ${journal.id} has no created list`)
  if (journal.dryRun) throw new Error(`journal ${journal.id} was a dry run; nothing to roll back`)

  const roots = rollbackRoots({ cwd, config })
  const removed = []
  const skipped = []

  for (const created of [...journal.created].reverse()) {
    if (!created || typeof created.path !== 'string' || !['dir', 'file'].includes(created.kind)) {
      skipped.push({ path: String(created?.path ?? '(invalid entry)'), reason: 'malformed journal entry' })
      continue
    }
    const path = created.path
    if (!isWithin(path, roots)) {
      skipped.push({ path, reason: 'outside the state directory and backup target' })
      continue
    }
    if (created.protected) {
      // The journal directory is the audit trail; keeping it is the point.
      skipped.push({ path, reason: 'protected: holds apply journal' })
      continue
    }
    if (!existsSync(path)) {
      skipped.push({ path, reason: 'already absent' })
      continue
    }
    if (created.kind === 'file') {
      // A file entry without a recorded hash cannot prove it is unchanged, so it
      // is never deleted.
      if (typeof created.hash !== 'string' || created.hash === '') {
        skipped.push({ path, reason: 'file entry has no recorded hash' })
        continue
      }
      const current = fileHash(path)
      if (current !== created.hash) {
        skipped.push({ path, reason: 'file changed since apply' })
        continue
      }
      if (!dryRun) unlinkSync(path)
      removed.push({ path, kind: 'file' })
      continue
    }
    // directory: only remove when empty, so user data is never destroyed
    const entries = readdirSync(path)
    if (entries.length > 0) {
      skipped.push({ path, reason: `directory not empty (${entries.length} entries)` })
      continue
    }
    if (!dryRun) rmdirSync(path)
    removed.push({ path, kind: 'dir' })
  }

  let record = null
  if (!dryRun) {
    record = writeRollbackRecord(cwd, journal, {
      removed,
      skipped,
      dryRun: false,
    })
  }

  return { id: journal.id, dryRun, removed, skipped, record }
}

export function describeApply(result) {
  const lines = []
  lines.push(result.dryRun ? 'apply (dry run): nothing written' : `applied ${result.id}`)
  if (result.actions.length === 0) lines.push('  nothing to do; every path already exists')
  for (const action of result.actions) {
    const wasCreated = result.created.some((c) => c.path === action.path)
    const marker = wasCreated ? 'created' : result.dryRun ? 'would create' : 'exists     '
    lines.push(`  ${marker.padEnd(12)} ${action.path}  (${action.reason})`)
  }
  return lines.join('\n')
}

export function describeVerify(result) {
  const lines = result.checks.map((check) => `[${check.status}] ${check.id}: ${check.detail}`)
  lines.push('', result.ok ? 'verify: consistent' : 'verify: needs attention')
  return lines.join('\n')
}

export function describeRollback(result) {
  const lines = [`rollback ${result.id}${result.dryRun ? ' (dry run)' : ''}`]
  if (result.removed.length === 0) lines.push('  removed nothing')
  for (const item of result.removed) lines.push(`  removed ${item.path}`)
  for (const item of result.skipped) lines.push(`  kept    ${item.path}  (${item.reason})`)
  return lines.join('\n')
}
