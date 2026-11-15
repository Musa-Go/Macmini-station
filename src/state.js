/**
 * Apply journal: a local, append-only record of what `station apply` created.
 *
 * The journal is what makes rollback safe: it records only paths this tool
 * actually created, so rollback never guesses and never touches user data it did
 * not write. It lives under `.station/` in the working directory and is
 * git-ignored by default.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_DIR = '.station'
export const JOURNAL_DIR = join(STATE_DIR, 'journal')

export function stateDir(cwd) {
  return join(cwd, STATE_DIR)
}

export function journalDir(cwd) {
  return join(cwd, JOURNAL_DIR)
}

/**
 * Recursively sort object keys so the hash depends on values only.
 * JSON.stringify's replacer-array form is a property whitelist applied at every
 * depth, which silently drops nested fields — not what drift detection needs.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => key !== '__meta').sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function configHash(config) {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
}

export function newJournalId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const suffix = Math.random().toString(36).slice(2, 6)
  return `apply-${stamp}-${suffix}`
}

export function journalPath(cwd, id) {
  return join(journalDir(cwd), `${id}.json`)
}

export function listJournals(cwd) {
  const dir = journalDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.rollback.json'))
    .sort()
    .map((name) => ({
      id: name.replace(/\.json$/, ''),
      path: join(dir, name),
      journal: JSON.parse(readFileSync(join(dir, name), 'utf8')),
    }))
}

export function latestJournal(cwd) {
  const all = listJournals(cwd)
  return all.length === 0 ? null : all[all.length - 1]
}

export function findJournal(cwd, id) {
  const path = journalPath(cwd, id)
  if (!existsSync(path)) return null
  return { id, path, journal: JSON.parse(readFileSync(path, 'utf8')) }
}

export function writeJournal(cwd, journal) {
  mkdirSync(journalDir(cwd), { recursive: true })
  const path = journalPath(cwd, journal.id)
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o644 })
  return path
}

export function writeRollbackRecord(cwd, journal, result) {
  mkdirSync(journalDir(cwd), { recursive: true })
  const path = join(journalDir(cwd), `${journal.id}.rollback.json`)
  writeFileSync(
    path,
    `${JSON.stringify({ journalId: journal.id, rolledBackAt: new Date().toISOString(), ...result }, null, 2)}\n`,
    { mode: 0o644 },
  )
  return path
}