#!/usr/bin/env node
/**
 * Hardening drill.
 *
 * Re-runs the security properties that were added after the code review, against
 * throwaway repositories in a temp directory. This is deliberately separate from
 * `npm test`: the drill is what an operator can run on a real machine to see the
 * guarantees as behaviour, not just as unit assertions.
 *
 * Usage: node scripts/drill.mjs [--json]
 * Exit:  0 all drills passed, 1 something failed, 2 the environment is unusable.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const { defaultConfig, configPath } = await import(join(ROOT, 'src/config.js'))
const { apply, rollback, verify } = await import(join(ROOT, 'src/apply.js'))
const { journalDir, writeJournal } = await import(join(ROOT, 'src/state.js'))
const { createWorktree, listWorktrees, jobsDir, worktreeFingerprint } = await import(join(ROOT, 'src/worktree.js'))
const { commitJob } = await import(join(ROOT, 'src/publish.js'))
const { backup } = await import(join(ROOT, 'src/backup.js'))
const { expose, readPublished, writePublished } = await import(join(ROOT, 'src/remote.js'))
const { runTask } = await import(join(ROOT, 'src/jobrun.js'))

const results = []

async function record(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}: ${a} !== ${b}`)
}

function git(cwd, args) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'station-drill-'))
  const repo = join(dir, 'repo')
  const station = join(dir, 'station')
  mkdirSync(repo)
  mkdirSync(station)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), '# drill\n')
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=drill', '-c', 'user.email=drill@local', 'commit', '-q', '-m', 'base'])
  return { dir, repo, station }
}

function writeConfig(station, mutate) {
  const config = defaultConfig()
  mutate?.(config)
  writeFileSync(configPath({ cwd: station }), JSON.stringify(config, null, 2))
  return config
}

// --- 1. gate lifecycle ------------------------------------------------------
await record('gate: commit without a passing run is refused', () => {
  const ws = makeWorkspace()
  const config = writeConfig(ws.station, (c) => {
    c.agent = { enabled: true, workingDirectory: ws.repo, tasks: { test: ['node', '-e', 'process.exit(0)'] }, gate: { task: 'test' }, taskTimeoutSeconds: 30 }
  })
  const job = createWorktree({ cwd: ws.station, repo: ws.repo })
  writeFileSync(join(job.path, 'change.txt'), 'x\n')
  let refused = false
  try {
    commitJob({ cwd: ws.station, config, job, message: 'no gate' })
  } catch (error) {
    refused = /run the gate task first/.test(String(error?.message))
  }
  assert(refused, 'commit should be refused before the gate runs')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'refused as expected'
})

await record('gate: a passing run allows the commit, a later edit blocks it', async () => {
  const ws = makeWorkspace()
  const config = writeConfig(ws.station, (c) => {
    c.agent = { enabled: true, workingDirectory: ws.repo, tasks: { test: ['node', '-e', 'process.exit(0)'] }, gate: { task: 'test' }, taskTimeoutSeconds: 30 }
  })
  const job = createWorktree({ cwd: ws.station, repo: ws.repo })
  writeFileSync(join(job.path, 'change.txt'), 'x\n')
  const run = await runTask({ cwd: ws.station, job, task: 'test', config })
  assert(run.ok, 'gate task should pass')
  const committed = commitJob({ cwd: ws.station, config, job, message: 'gated' })
  assert(committed.committed === true, 'commit should succeed after a passing gate')
  assert(committed.gate.enforced === true, 'gate should report as enforced')

  writeFileSync(join(job.path, 'change.txt'), 'different\n')
  let refused = false
  try {
    commitJob({ cwd: ws.station, config, job, message: 'after edit' })
  } catch (error) {
    refused = /working tree changed|gate task|nothing to commit/.test(String(error?.message))
  }
  assert(refused, 'a second commit without re-running the gate must not silently pass')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'commit gated, re-edit detected'
})

// --- 2. forged journal ------------------------------------------------------
await record('rollback: a forged journal cannot delete a file', () => {
  const ws = makeWorkspace()
  const config = writeConfig(ws.station)
  apply({ cwd: ws.station, config })
  const victim = join(ws.dir, 'victim.txt')
  writeFileSync(victim, 'keep me')
  mkdirSync(journalDir(ws.station), { recursive: true })
  writeFileSync(
    join(journalDir(ws.station), 'apply-20260101T000000-abcd.json'),
    JSON.stringify({
      id: 'apply-20260101T000000-abcd',
      createdAt: '2026-01-01T00:00:00.000Z',
      dryRun: false,
      configHash: 'x',
      created: [{ path: victim, kind: 'file' }],
      actions: [],
    }),
  )
  let refused = false
  try {
    rollback({ cwd: ws.station, config, to: 'apply-20260101T000000-abcd' })
  } catch (error) {
    refused = /failed verification/.test(String(error?.message))
  }
  assert(refused, 'unsigned journal must be refused')
  assert(existsSync(victim), 'the target file must still exist')
  const report = verify({ cwd: ws.station, config })
  assert(
    report.checks.some((check) => check.id === 'journal-integrity' && check.status === 'critical'),
    'verify should flag the bad journal',
  )
  rmSync(ws.dir, { recursive: true, force: true })
  return 'refused, file intact'
})

await await record('rollback: a signed journal cannot reach outside its roots', () => {
  const ws = makeWorkspace()
  const config = writeConfig(ws.station, (c) => {
    c.storage.backup.target = { type: 'local', path: join(ws.dir, 'backups') }
  })
  const applied = apply({ cwd: ws.station, config })
  const outside = join(ws.dir, 'outside.txt')
  writeFileSync(outside, 'outside')
  // Inside an allowed root on purpose: this entry must be kept because it has no
  // recorded hash, not because of the path check.
  const hashless = join(ws.station, '.station', 'hashless.txt')
  writeFileSync(hashless, 'data')
  const journal = JSON.parse(readFileSync(join(journalDir(ws.station), `${applied.id}.json`), 'utf8'))
  writeJournal(ws.station, {
    ...journal,
    created: [...journal.created, { path: outside, kind: 'file', hash: 'x' }, { path: hashless, kind: 'file' }],
  })
  const result = rollback({ cwd: ws.station, config, to: applied.id })
  assert(existsSync(outside), 'outside path must not be deleted')
  assert(existsSync(hashless), 'file without a recorded hash must not be deleted')
  const reasons = result.skipped.map((item) => item.reason).join(' | ')
  assert(/outside the state directory/.test(reasons), 'skipped reason should mention the root check')
  assert(/no recorded hash/.test(reasons), 'skipped reason should mention the missing hash')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'outside path and hashless file kept'
})

// --- 3. job metadata tampering ---------------------------------------------
await record('publishing: a redirected job record cannot commit onto main', () => {
  const ws = makeWorkspace()
  const config = writeConfig(ws.station, (c) => {
    c.agent = { enabled: true, workingDirectory: ws.repo }
  })
  const job = createWorktree({ cwd: ws.station, repo: ws.repo })
  writeFileSync(join(ws.repo, 'injected.txt'), 'evil\n')
  const recordPath = join(jobsDir(ws.station), `${job.id}.json`)
  const original = JSON.parse(readFileSync(recordPath, 'utf8'))
  writeFileSync(recordPath, JSON.stringify({ ...original, path: ws.repo }, null, 2))
  let refused = false
  try {
    commitJob({ cwd: ws.station, config, job: { ...job, path: ws.repo }, message: 'forged' })
  } catch (error) {
    refused = /no trusted job record|not the worktree directory/.test(String(error?.message))
  }
  assert(refused, 'tampered record must be refused')
  assert(git(ws.repo, ['log', '-1', '--pretty=%s']) === 'base', 'source repository must stay at its original commit')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'refused, main untouched'
})

// --- 4. remote access reconciliation ---------------------------------------
await record('expose: ports dropped from the config are unpublished', () => {
  const ws = makeWorkspace()
  const calls = []
  const probe = (command, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'version') return { ok: true, stdout: 'tailscale 1.0' }
    if (args[0] === 'status') return { ok: true, stdout: '100.110.77.80 node' }
    return { ok: true, stdout: '' }
  }
  writePublished({ cwd: ws.station, ports: [8443, 8444] })
  const config = defaultConfig()
  config.remoteAccess = { enabled: true, provider: 'tailscale', ports: [8443] }
  // `exists` is injected so the drill works on a machine without Tailscale.
  const result = expose({ cwd: ws.station, config, probe, exists: () => true })
  assert(result.ok, `expose should succeed: ${JSON.stringify(result)}`)
  assert(calls.some((call) => call.includes('--https=8444') && call.includes('off')), 'the dropped port should be turned off')
  assertDeepEqual(readPublished({ cwd: ws.station }), [8443], 'published state should record only the live port')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'stale port 8444 turned off'
})

await record('expose: --off still works after remote access is disabled', () => {
  const ws = makeWorkspace()
  const calls = []
  const probe = (command, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'version') return { ok: true, stdout: 'tailscale 1.0' }
    return { ok: true, stdout: '' }
  }
  writePublished({ cwd: ws.station, ports: [8443] })
  const config = defaultConfig()
  config.remoteAccess = { enabled: false, provider: 'tailscale' }
  const result = expose({ cwd: ws.station, config, off: true, probe, exists: () => true })
  assert(result.ok, `off should succeed: ${JSON.stringify(result)}`)
  assert(calls.some((call) => call.includes('--https=8443') && call.includes('off')), 'the recorded port should be turned off')
  assertDeepEqual(readPublished({ cwd: ws.station }), [], 'published state should be empty after --off')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'disabled config can still unpublish'
})

// --- 5. backup fail-closed paths -------------------------------------------
await record('backup: an unsupported target type writes nothing locally', () => {
  const ws = makeWorkspace()
  const config = writeConfig(ws.station, (c) => {
    c.storage.backup.target = { type: 's3-restic', path: join(ws.dir, 's3') }
  })
  const result = backup({ cwd: ws.station, config, env: { RESTIC_PASSWORD_FILE: '/dev/null' } })
  assert(result.ok === false, 'unsupported target must fail')
  assert(result.stage === 'target', `expected stage=target, got ${result.stage}`)
  assert(!existsSync(join(ws.dir, 's3')), 'nothing may be created for an unsupported target')
  rmSync(ws.dir, { recursive: true, force: true })
  return 'failed closed'
})

await record('backup: a world-readable password file is refused', () => {
  const ws = makeWorkspace()
  const passwordFile = join(ws.dir, 'restic.pass')
  writeFileSync(passwordFile, 'secret')
  chmodSync(passwordFile, 0o644)
  const fakeRestic = join(ws.dir, 'restic')
  writeFileSync(fakeRestic, '#!/bin/sh\nif [ "$1" = version ]; then echo "restic 0.18.0"; fi\nexit 0\n')
  chmodSync(fakeRestic, 0o755)
  const config = writeConfig(ws.station, (c) => {
    c.storage.backup.target = { type: 'local', path: join(ws.dir, 'backups') }
  })
  const result = backup({
    cwd: ws.station,
    config,
    env: { RESTIC_BIN: fakeRestic, RESTIC_PASSWORD_FILE: passwordFile },
  })
  assert(result.ok === false, 'permissive password file must be refused')
  assert(result.stage === 'password', `expected stage=password, got ${result.stage}`)
  assert(/readable by other users/.test(result.error), `unexpected error: ${result.error}`)
  rmSync(ws.dir, { recursive: true, force: true })
  return 'refused with chmod guidance'
})

// --- report -----------------------------------------------------------------
const failures = results.filter((item) => !item.ok)
const asJson = process.argv.includes('--json')

if (asJson) {
  process.stdout.write(`${JSON.stringify({ results, failures: failures.length }, null, 2)}\n`)
} else {
  const width = Math.max(...results.map((item) => item.name.length))
  for (const item of results) {
    process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(width)}  ${item.detail}\n`)
  }
  process.stdout.write(`\n${results.length - failures.length}/${results.length} drills passed\n`)
}

process.exitCode = failures.length === 0 ? 0 : 1