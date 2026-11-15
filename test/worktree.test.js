import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorktree, isClean, listWorktrees, removeWorktree, repoRoot } from '../src/worktree.js'
import { jobsDir, worktreesDir } from '../src/worktree.js'

function git(cwd, args) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function tempRepo() {
  // Compare against the real path: git reports the resolved location, and on
  // macOS /var is a symlink to /private/var.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'station-wt-')))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])
  const station = join(dir, 'station')
  mkdirSync(station)
  return { dir, repo, station, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('repoRoot rejects a non-git directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'station-nogit-'))
  try {
    const result = repoRoot(dir)
    assert.equal(result.ok, false)
    assert.match(result.error, /not a git repository/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isClean distinguishes clean and dirty trees', () => {
  const t = tempRepo()
  try {
    assert.deepEqual(isClean(t.repo).clean, true)
    writeFileSync(join(t.repo, 'stray.txt'), 'x')
    const dirty = isClean(t.repo)
    assert.equal(dirty.clean, false)
    assert.match(dirty.detail, /stray/)
  } finally {
    t.cleanup()
  }
})

test('createWorktree prepares an isolated branch at the recorded baseline', () => {
  const t = tempRepo()
  try {
    const base = git(t.repo, ['rev-parse', 'HEAD'])
    const job = createWorktree({ cwd: t.station, repo: t.repo, branch: 'anything' })
    assert.equal(job.base, base)
    assert.ok(job.branch.startsWith('station/job-'))
    assert.equal(existsSync(job.path), true)
    assert.equal(git(job.path, ['rev-parse', 'HEAD']), base)
    assert.equal(git(job.path, ['rev-parse', '--abbrev-ref', 'HEAD']), job.branch)

    const record = JSON.parse(readFileSync(join(jobsDir(t.station), `${job.id}.json`), 'utf8'))
    assert.equal(record.id, job.id)
    assert.equal(record.repo, realpathSync(t.repo))
    assert.equal(record.status, 'prepared')

    // The source repository is untouched: no new files there.
    assert.equal(git(t.repo, ['status', '--porcelain']), '')
  } finally {
    t.cleanup()
  }
})

test('createWorktree refuses a dirty source repository', () => {
  const t = tempRepo()
  try {
    writeFileSync(join(t.repo, 'dirty.txt'), 'x')
    assert.throws(
      () => createWorktree({ cwd: t.station, repo: t.repo, branch: 'b' }),
      /uncommitted changes/,
    )
  } finally {
    t.cleanup()
  }
})

test('createWorktree requires --repo and rejects an unsafe label', () => {
  const t = tempRepo()
  try {
    assert.throws(() => createWorktree({ cwd: t.station, repo: '', branch: 'b' }), /--repo/)
    assert.throws(() => createWorktree({ cwd: t.station, repo: t.repo, branch: 'has space' }), /label may only contain/)
    assert.throws(() => createWorktree({ cwd: t.station, repo: t.repo, branch: '../escape' }), /label may only contain/)
  } finally {
    t.cleanup()
  }
})

test('createWorktree works without a label and records one when given', () => {
  const t = tempRepo()
  try {
    const plain = createWorktree({ cwd: t.station, repo: t.repo })
    assert.equal(plain.label, null)
    assert.ok(plain.branch.startsWith('station/job-'))

    const labelled = createWorktree({ cwd: t.station, repo: t.repo, branch: 'fix-login' })
    assert.equal(labelled.label, 'fix-login')
    assert.ok(labelled.branch.startsWith('station/job-'))
  } finally {
    t.cleanup()
  }
})

test('listWorktrees returns prepared jobs and tolerates corruption', () => {
  const t = tempRepo()
  try {
    const job = createWorktree({ cwd: t.station, repo: t.repo })
    const list = listWorktrees({ cwd: t.station })
    assert.equal(list.length, 1)
    assert.equal(list[0].id, job.id)

    writeFileSync(join(jobsDir(t.station), 'broken.json'), '{ not json')
    assert.equal(listWorktrees({ cwd: t.station }).length, 1, 'corrupt records are skipped, not fatal')
  } finally {
    t.cleanup()
  }
})

test('removeWorktree cleans up branch and record when the tree is clean', () => {
  const t = tempRepo()
  try {
    const job = createWorktree({ cwd: t.station, repo: t.repo })
    const result = removeWorktree({ cwd: t.station, id: job.id })
    assert.equal(result.removed, true)
    assert.equal(existsSync(job.path), false)
    assert.equal(existsSync(join(jobsDir(t.station), `${job.id}.json`)), false)
    assert.throws(() => git(t.repo, ['rev-parse', '--verify', job.branch]), /Command failed|fatal/)
  } finally {
    t.cleanup()
  }
})

test('removeWorktree refuses to discard uncommitted work without --force', () => {
  const t = tempRepo()
  try {
    const job = createWorktree({ cwd: t.station, repo: t.repo })
    writeFileSync(join(job.path, 'work-in-progress.txt'), 'x')
    assert.throws(() => removeWorktree({ cwd: t.station, id: job.id }), /uncommitted changes/)
    assert.equal(existsSync(join(job.path, 'work-in-progress.txt')), true)

    const forced = removeWorktree({ cwd: t.station, id: job.id, force: true })
    assert.equal(forced.removed, true)
    assert.equal(existsSync(job.path), false)
  } finally {
    t.cleanup()
  }
})

test('removeWorktree rejects an unknown id', () => {
  const t = tempRepo()
  try {
    assert.throws(() => removeWorktree({ cwd: t.station, id: 'job-nope' }), /no worktree record/)
  } finally {
    t.cleanup()
  }
})

test('state directories live under .station and are created on demand', () => {
  const t = tempRepo()
  try {
    assert.ok(worktreesDir(t.station).endsWith(join('.station', 'worktrees')))
    assert.ok(jobsDir(t.station).endsWith(join('.station', 'jobs')))
    assert.equal(existsSync(worktreesDir(t.station)), false)
    createWorktree({ cwd: t.station, repo: t.repo })
    assert.equal(existsSync(worktreesDir(t.station)), true)
  } finally {
    t.cleanup()
  }
})