import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDefaultConfig, defaultConfig, configPath } from '../src/config.js'
import { apply, planApply, verify, rollback } from '../src/apply.js'
import { journalDir, stateDir } from '../src/state.js'

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'station-apply-'))
  // Point the backup target inside the sandbox so tests never touch $HOME.
  const config = defaultConfig()
  config.storage.backup.target = { type: 'local', path: join(dir, 'backups') }
  writeFileSync(configPath({ cwd: dir }), JSON.stringify(config, null, 2))
  return {
    dir,
    backups: join(dir, 'backups'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('apply requires station.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'station-apply-cfg-'))
  try {
    assert.throws(() => apply({ cwd: dir }), /run `station init`/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planApply is pure and reports the state dir plus backup target', () => {
  const s = sandbox()
  try {
    const actions = planApply({ config: defaultConfig(), cwd: s.dir })
    const paths = actions.map((a) => a.path)
    assert.ok(paths.includes(stateDir(s.dir)))
    assert.equal(existsSync(stateDir(s.dir)), false, 'planApply must not create anything')
  } finally {
    s.cleanup()
  }
})

test('apply creates directories, writes a journal, and never starts services', () => {
  const s = sandbox()
  try {
    const result = apply({ cwd: s.dir })
    assert.equal(result.dryRun, false)
    assert.ok(existsSync(stateDir(s.dir)))
    assert.ok(existsSync(s.backups), 'backup target should be created')
    const journals = readdirSync(journalDir(s.dir))
    assert.equal(journals.length, 1)
    const journal = JSON.parse(readFileSync(join(journalDir(s.dir), journals[0]), 'utf8'))
    assert.equal(journal.id, result.id)
    assert.ok(journal.created.length >= 1)
    for (const entry of journal.created) assert.ok(entry.path.startsWith('/'))
    // No service files anywhere: apply must not write launchd plists.
    assert.equal(existsSync(join(s.dir, 'Library')), false)
  } finally {
    s.cleanup()
  }
})

test('apply --dry-run writes nothing', () => {
  const s = sandbox()
  try {
    const result = apply({ cwd: s.dir, dryRun: true })
    assert.equal(result.dryRun, true)
    assert.ok(result.actions.length >= 1)
    assert.equal(existsSync(stateDir(s.dir)), false)
    assert.equal(existsSync(s.backups), false)
  } finally {
    s.cleanup()
  }
})

test('apply is idempotent', () => {
  const s = sandbox()
  try {
    apply({ cwd: s.dir })
    const second = apply({ cwd: s.dir })
    assert.equal(second.created.length, 0, 'second run must not claim new creations')
  } finally {
    s.cleanup()
  }
})

test('verify is consistent after apply and warns after config drift', () => {
  const s = sandbox()
  try {
    apply({ cwd: s.dir })
    const clean = verify({ cwd: s.dir })
    assert.equal(clean.ok, true, JSON.stringify(clean.checks))

    const drifted = JSON.parse(readFileSync(configPath({ cwd: s.dir }), 'utf8'))
    drifted.machine.displayName = 'renamed'
    writeFileSync(configPath({ cwd: s.dir }), JSON.stringify(drifted, null, 2))
    const after = verify({ cwd: s.dir })
    assert.ok(after.checks.some((c) => c.id === 'config-drift' && c.status === 'warn'))
    assert.equal(after.ok, false)
  } finally {
    s.cleanup()
  }
})

test('rollback removes what apply created and keeps user data', () => {
  const s = sandbox()
  try {
    const applied = apply({ cwd: s.dir })
    // Simulate the user putting data in the backup directory afterwards.
    writeFileSync(join(s.backups, 'important.txt'), 'keep me')

    const result = rollback({ cwd: s.dir })
    assert.equal(result.id, applied.id)
    const removedPaths = result.removed.map((r) => r.path)
    assert.ok(!removedPaths.includes(stateDir(s.dir)), 'state dir is protected: it holds the journal')
    assert.ok(result.skipped.some((s2) => s2.path === stateDir(s.dir) && /protected/.test(s2.reason)))
    assert.ok(!removedPaths.includes(s.backups), 'non-empty dir must be kept')
    assert.ok(result.skipped.some((s2) => s2.path === s.backups && /not empty/.test(s2.reason)))
    assert.equal(existsSync(join(s.backups, 'important.txt')), true)
  } finally {
    s.cleanup()
  }
})

test('rollback --dry-run changes nothing', () => {
  const s = sandbox()
  try {
    apply({ cwd: s.dir })
    const before = readdirSync(join(stateDir(s.dir), 'journal')).length
    rollback({ cwd: s.dir, dryRun: true })
    assert.equal(readdirSync(join(stateDir(s.dir), 'journal')).length, before)
  } finally {
    s.cleanup()
  }
})

test('rollback refuses a dry-run journal and unknown ids', () => {
  const s = sandbox()
  try {
    apply({ cwd: s.dir, dryRun: true })
    assert.throws(() => rollback({ cwd: s.dir }), /dry run|no apply journal/)
    assert.throws(() => rollback({ cwd: s.dir, to: 'apply-nope' }), /no journal/)
  } finally {
    s.cleanup()
  }
})

test('rollback writes a rollback record next to the journal', () => {
  const s = sandbox()
  try {
    const applied = apply({ cwd: s.dir })
    rollback({ cwd: s.dir })
    const files = readdirSync(journalDir(s.dir))
    assert.ok(files.some((f) => f === `${applied.id}.rollback.json`))
  } finally {
    s.cleanup()
  }
})