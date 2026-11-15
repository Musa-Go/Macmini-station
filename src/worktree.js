/**
 * Isolated worktrees for agent jobs (M4.1).
 *
 * This module prepares a safe place to run a job later; it does not execute
 * anything. The rules it enforces come from docs/AGENT-JOBS.md:
 *   - one worktree and one `station/job-<id>` branch per job;
 *   - the source repository must be clean, so the recorded baseline is truthful;
 *   - removal is explicit and refuses to discard uncommitted work without --force.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { stateDir } from './state.js'

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
  mkdirSync(jobsDir(cwd), { recursive: true })
  writeFileSync(join(jobsDir(cwd), `${id}.json`), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o644 })
  return job
}

export function listWorktrees({ cwd }) {
  const dir = jobsDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
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

export function describeWorktrees(list) {
  if (list.length === 0) return 'no prepared worktrees'
  const lines = list.map((job) => `${job.id}  ${job.branch}  base ${job.base.slice(0, 8)}  ${job.repo}`)
  return lines.join('\n')
}