/**
 * Isolated worktrees for agent jobs (M4.1).
 *
 * This module prepares a safe place to run a job later; it does not execute
 * anything. The rules it enforces come from docs/AGENT-JOBS.md:
 *   - one worktree and one `station/job-<id>` branch per job;
 *   - the source repository must be clean, so the recorded baseline is truthful;
 *   - removal is explicit and refuses to discard uncommitted work without --force.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { stateDir } from './state.js'

export const JOB_ID_PATTERN = /^job-[0-9]{8}T[0-9]{6}-[a-z0-9]{4}$/
export const JOB_BRANCH_PREFIX = 'station/job-'

export function worktreesDir(cwd) {
  return join(stateDir(cwd), 'worktrees')
}

export function jobsDir(cwd) {
  return join(stateDir(cwd), 'jobs')
}

export function newJobId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return `job-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    const stdout = execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, stdout: String(stdout).trim() }
  } catch (error) {
    if (allowFailure) {
      return { ok: false, stdout: '', error: String(error?.stderr ?? error?.message ?? error).trim() }
    }
    throw new Error(`git ${args.join(' ')} failed: ${String(error?.stderr ?? error?.message ?? error).trim().slice(0, 200)}`)
  }
}

export function repoRoot(path) {
  const result = git(path, ['rev-parse', '--show-toplevel'], { allowFailure: true })
  if (!result.ok || result.stdout === '') return { ok: false, error: `not a git repository: ${path}` }
  return { ok: true, root: result.stdout }
}

export function isClean(root) {
  const result = git(root, ['status', '--porcelain'], { allowFailure: true })
  if (!result.ok) return { ok: false, error: result.error ?? 'git status failed' }
  return { ok: true, clean: result.stdout === '', detail: result.stdout.split('\n').slice(0, 5).join(', ') }
}

export function createWorktree({ cwd, repo, branch = '' }) {
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('--repo is required')
  // `branch` is a human label, not the branch name: the job branch is always
  // derived from the job id so it can never point at main or a user branch.
  const label = String(branch).trim()
  if (label !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    throw new Error('--branch label may only contain letters, digits, dot, underscore and dash')
  }

  const rootResult = repoRoot(resolve(repo))
  if (!rootResult.ok) throw new Error(rootResult.error)
  const root = rootResult.root

  const cleanliness = isClean(root)
  if (!cleanliness.ok) throw new Error(cleanliness.error)
  if (!cleanliness.clean) {
    throw new Error(`source repository has uncommitted changes (${cleanliness.detail}); commit or stash them first so the baseline is truthful`)
  }

  const base = git(root, ['rev-parse', 'HEAD']).stdout
  const id = newJobId()
  const branchName = `station/job-${id.replace(/^job-/, '')}`
  const path = join(worktreesDir(cwd), id)

  if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`)
  const branchExists = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], { allowFailure: true })
  if (branchExists.ok) throw new Error(`branch already exists: ${branchName}`)

  mkdirSync(worktreesDir(cwd), { recursive: true })
  git(root, ['worktree', 'add', '-b', branchName, path, base])

  const job = {
    id,
    repo: root,
    label: label || null,
    branch: branchName,
    path,
    base,
    createdAt: new Date().toISOString(),
    status: 'prepared',
  }
  try {
    mkdirSync(jobsDir(cwd), { recursive: true })
    writeFileSync(join(jobsDir(cwd), `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o644 })
    const problem = validateJobRecord(cwd, job, `${id}.json`)
    if (problem) throw new Error(`internal error, job record is invalid: ${problem}`)
  } catch (error) {
    // A worktree without a record can never be published or cleaned up, so undo it.
    git(root, ['worktree', 'remove', '--force', path], { allowFailure: true })
    git(root, ['branch', '-D', branchName], { allowFailure: true })
    throw error
  }
  return job
}

/**
 * A job record is a local, editable file, so it is treated as untrusted input:
 * every field used to decide "where to run" is re-derived and cross-checked
 * against git before anything is committed or pushed.
 */
export function validateJobRecord(cwd, record, filename) {
  if (!record || typeof record !== 'object') return 'record is not an object'
  if (typeof record.id !== 'string' || !JOB_ID_PATTERN.test(record.id)) return 'id is not a recognised job id'
  if (filename && filename !== `${record.id}.json`) return 'record filename does not match its id'
  if (typeof record.repo !== 'string' || record.repo.trim() === '') return 'repo is missing'
  if (typeof record.branch !== 'string' || !record.branch.startsWith(JOB_BRANCH_PREFIX)) {
    return `branch must start with ${JOB_BRANCH_PREFIX}`
  }
  if (record.branch !== `${JOB_BRANCH_PREFIX}${record.id.slice('job-'.length)}`) {
    return 'branch does not belong to this job id'
  }
  if (typeof record.path !== 'string' || resolve(record.path) !== resolve(join(worktreesDir(cwd), record.id))) {
    return 'path is not the worktree directory for this job'
  }
  if (typeof record.base !== 'string' || !/^[0-9a-f]{40}$/.test(record.base)) return 'base commit is invalid'
  return null
}

export function listWorktrees({ cwd }) {
  const dir = jobsDir(cwd)
  if (!existsSync(dir)) return []
  const records = []
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const problem = validateJobRecord(cwd, parsed, name)
    if (problem) continue
    records.push(parsed)
  }
  return records
}

/**
 * Prove that a job really owns its path before touching git: the path must be a
 * registered worktree of the recorded repo and must currently have the job
 * branch checked out. This is what stops a doctored record from pointing a
 * commit at `main`.
 */
export function assertTrustedJob({ cwd, job, gitImpl = git }) {
  const record = listWorktrees({ cwd }).find((item) => item.id === job?.id)
  if (!record) throw new Error(`no trusted job record for ${job?.id ?? '(missing)'}`)
  const storedPath = record.path

  const list = gitImpl(record.repo, ['worktree', 'list', '--porcelain'], { allowFailure: true })
  if (!list.ok) throw new Error(`cannot inspect worktrees of ${record.repo}: ${list.error ?? 'git failed'}`)
  const registered = list.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length).trim()))
  if (!registered.includes(resolve(storedPath))) {
    throw new Error(`worktree path is not registered with git: ${storedPath}`)
  }

  const head = gitImpl(storedPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true })
  if (!head.ok) throw new Error(`cannot read the current branch of ${storedPath}`)
  if (head.stdout !== record.branch) {
    throw new Error(`worktree has ${head.stdout} checked out, expected ${record.branch}; refusing to act on it`)
  }
  return record
}

/** Fingerprint of the working tree so a test result can be tied to exact content. */
export function worktreeFingerprint({ path, gitImpl = git }) {
  const status = gitImpl(path, ['status', '--porcelain'], { allowFailure: true })
  if (!status.ok) throw new Error(`cannot read worktree status: ${status.error ?? 'git failed'}`)
  const lines = status.stdout.split('\n').filter(Boolean).sort()
  const hash = createHash('sha256')
  for (const line of lines) {
    const relative = line.slice(3).trim()
    hash.update(`${line}\n`)
    const tracked = gitImpl(path, ['rev-parse', '--verify', '--quiet', `HEAD:${relative}`], { allowFailure: true })
    if (tracked.ok) {
      const blob = gitImpl(path, ['rev-parse', `${'HEAD'}:${relative}`], { allowFailure: true })
      if (blob.ok) hash.update(blob.stdout)
    }
    if (existsSync(join(path, relative))) {
      const object = gitImpl(path, ['hash-object', '--', relative], { allowFailure: true })
      if (object.ok) hash.update(object.stdout)
    }
  }
  return hash.digest('hex').slice(0, 32)
}

export function removeWorktree({ cwd, id, force = false }) {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('worktree id is required')
  const record = listWorktrees({ cwd }).find((job) => job.id === id)
  if (!record) throw new Error(`no worktree record with id ${id}`)

  if (existsSync(record.path)) {
    const dirty = git(record.path, ['status', '--porcelain'], { allowFailure: true })
    if (!dirty.ok) throw new Error(`cannot inspect worktree: ${dirty.error}`)
    if (dirty.stdout !== '' && !force) {
      const files = dirty.stdout.split('\n').slice(0, 5).join(', ')
      throw new Error(`worktree has uncommitted changes (${files}); pass --force to discard them`)
    }
    git(record.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), record.path])
  }

  git(record.repo, ['branch', '-D', record.branch], { allowFailure: true })
  const jobFile = join(jobsDir(cwd), `${record.id}.json`)
  if (existsSync(jobFile)) rmSync(jobFile)
  return { id: record.id, branch: record.branch, path: record.path, removed: true }
}

export function readJobRecord({ cwd, id }) {
  const path = join(jobsDir(cwd), `${id}.json`)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return validateJobRecord(cwd, parsed, `${id}.json`) ? null : parsed
  } catch {
    return null
  }
}

export function updateJobRecord({ cwd, id, patch }) {
  const current = readJobRecord({ cwd, id })
  if (!current) throw new Error(`no trusted job record for ${id}`)
  const next = { ...current, ...patch }
  writeFileSync(join(jobsDir(cwd), `${id}.json`), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 })
  return next
}

/**
 * Gate settings. A gate is only enforced when it is configured: an unconfigured
 * workspace publishes ungated, and every command says so instead of implying
 * that tests ran.
 */
export function gateConfig(config) {
  const gate = config?.agent?.gate
  if (!gate || typeof gate !== 'object') return { configured: false, task: null, required: false }
  const task = typeof gate.task === 'string' && gate.task.trim() !== '' ? gate.task.trim() : null
  return { configured: true, task, required: gate.required !== false }
}

export function gateTaskName(config) {
  return gateConfig(config).task
}

export function gateRequired(config) {
  const gate = gateConfig(config)
  return gate.configured && gate.required
}

export function describeWorktrees(list) {
  if (list.length === 0) return 'no prepared worktrees'
  const lines = list.map((job) => `${job.id}  ${job.branch}  base ${job.base.slice(0, 8)}  ${job.repo}`)
  return lines.join('\n')
}