/**
 * Apply journal: a local record of what `station apply` created.
 *
 * The journal is what makes rollback safe, so it must not be forgeable by a
 * naive edit: every journal carries an HMAC computed with a key that lives next
 * to it (mode 0600). That does not defend against an attacker who can read the
 * key, but it does stop "write a JSON file and delete arbitrary paths" and makes
 * accidental corruption loud instead of silently trusted.
 *
 * It lives under `.station/` in the working directory and is git-ignored.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const STATE_DIR = '.station'
export const JOURNAL_DIR = join(STATE_DIR, 'journal')
export const JOURNAL_KEY_FILE = join(JOURNAL_DIR, '.key')

export const JOURNAL_ID_PATTERN = /^apply-[0-9]{8}T[0-9]{6}-[a-z0-9]{4}$/

export function stateDir(cwd) {
  return join(cwd, STATE_DIR)
}

export function journalDir(cwd) {
  return join(cwd, JOURNAL_DIR)
}

export function journalKeyPath(cwd) {
  return join(cwd, JOURNAL_KEY_FILE)
}

/**
 * Recursively sort object keys so the hash depends on values only.
 * JSON.stringify's replacer-array form is a property whitelist applied at every
 * depth, which silently drops nested fields — not what drift detection needs.
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => key !== '__meta' && key !== 'mac')
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function configHash(config) {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
}

export function newJournalId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0').slice(0, 4)
  return `apply-${stamp}-${suffix}`
}

export function journalPath(cwd, id) {
  if (!JOURNAL_ID_PATTERN.test(String(id))) throw new Error(`invalid journal id: ${id}`)
  return join(journalDir(cwd), `${id}.json`)
}

function journalKey(cwd, { create = false } = {}) {
  const path = journalKeyPath(cwd)
  if (existsSync(path)) {
    const key = readFileSync(path)
    if (key.length >= 32) return key
    throw new Error(`journal key is corrupt: ${path}`)
  }
  if (!create) return null
  mkdirSync(journalDir(cwd), { recursive: true })
  const key = randomBytes(32)
  writeFileSync(path, key, { mode: 0o600 })
  return key
}

export function signJournal(cwd, journal) {
  const key = journalKey(cwd, { create: true })
  return createHmac('sha256', key).update(stableStringify(journal)).digest('hex').slice(0, 32)
}

export function verifyJournal(cwd, journal) {
  if (!journal || typeof journal !== 'object') return { ok: false, reason: 'journal is not an object' }
  if (typeof journal.mac !== 'string' || journal.mac === '') return { ok: false, reason: 'journal has no signature' }
  const key = journalKey(cwd)
  if (key === null) return { ok: false, reason: 'journal key is missing' }
  const expected = createHmac('sha256', key).update(stableStringify(journal)).digest('hex').slice(0, 32)
  const actual = journal.mac
  if (expected.length !== actual.length) return { ok: false, reason: 'journal signature is malformed' }
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
    return { ok: false, reason: 'journal signature does not match its content' }
  }
  return { ok: true }
}

export function listJournals(cwd) {
  const dir = journalDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.rollback.json') && !name.startsWith('.'))
    .sort()
    .map((name) => {
      const id = name.replace(/\.json$/, '')
      const path = join(dir, name)
      let journal = null
      let problem = null
      try {
        journal = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        problem = `journal is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      }
      if (journal && !problem) {
        if (!JOURNAL_ID_PATTERN.test(id)) problem = `journal id is not recognised: ${id}`
        else if (journal.id !== id) problem = `journal id does not match its filename: ${journal.id}`
      }
      const signature = journal && !problem ? verifyJournal(cwd, journal) : { ok: false, reason: problem ?? 'unreadable' }
      return { id, path, journal, valid: signature.ok, problem: signature.ok ? null : signature.reason }
    })
}

export function latestJournal(cwd) {
  const all = listJournals(cwd)
  return all.length === 0 ? null : all[all.length - 1]
}

export function findJournal(cwd, id) {
  const path = journalPath(cwd, id)
  if (!existsSync(path)) return null
  const journal = JSON.parse(readFileSync(path, 'utf8'))
  const signature = verifyJournal(cwd, journal)
  return { id, path, journal, valid: signature.ok, problem: signature.ok ? null : signature.reason }
}

export function writeJournal(cwd, journal) {
  mkdirSync(journalDir(cwd), { recursive: true })
  const mac = signJournal(cwd, journal)
  const signed = { ...journal, mac }
  const path = journalPath(cwd, journal.id)
  writeFileSync(path, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 })
  return path
}

export function writeRollbackRecord(cwd, journal, result) {
  mkdirSync(journalDir(cwd), { recursive: true })
  const path = join(journalDir(cwd), `${journal.id}.rollback.json`)
  writeFileSync(
    path,
    `${JSON.stringify({ journalId: journal.id, rolledBackAt: new Date().toISOString(), ...result }, null, 2)}\n`,
    { mode: 0o600 },
  )
  return path
}