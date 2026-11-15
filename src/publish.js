/**
 * Publishing a job (M4.4): commit inside the worktree, push the job branch, and
 * optionally open a Draft PR.
 *
 * Safety rules from docs/AGENT-JOBS.md:
 *   - commits happen only inside a prepared worktree of a recorded job;
 *   - only `station/job-*` branches may be pushed — never main, never a user branch;
 *   - PRs are created as drafts, never merged by this tool;
 *   - `gh` is optional: without it the tool prints the exact command instead of
 *     inventing a remote API call.
 */

import { execFileSync } from 'node:child_process'

export function jobBranchPattern(branch) {
  return typeof branch === 'string' && branch.startsWith('station/job-')
}

function git(cwd, args, { allowFailure = false, env } = {}) {
  try {
    const stdout = execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    return { ok: true, stdout: String(stdout).trim() }
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 300)
    if (allowFailure) return { ok: false, stdout: '', error: detail }
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
}

export function commitJob({ job, message, env, gitImpl = git }) {
  if (!jobBranchPattern(job.branch)) throw new Error(`refusing to commit on a non-job branch: ${job.branch}`)
  if (typeof message !== 'string' || message.trim() === '') throw new Error('a commit message is required')

  const status = gitImpl(job.path, ['status', '--porcelain'])
  if (status.stdout === '') return { ok: true, committed: false, detail: 'nothing to commit' }

  gitImpl(job.path, ['add', '-A'])
  const result = gitImpl(job.path, [
    '-c',
    'user.name=macmini-station',
    '-c',
    'user.email=macmini-station@local',
    'commit',
    '-q',
    '-m',
    message.trim(),
  ], { env })
  const head = gitImpl(job.path, ['rev-parse', 'HEAD']).stdout
  return { ok: true, committed: true, commit: head, branch: job.branch }
}

export function pushJob({ job, remote = 'origin', env, gitImpl = git }) {
  if (!jobBranchPattern(job.branch)) throw new Error(`refusing to push a non-job branch: ${job.branch}`)

  const hasRemote = gitImpl(job.repo, ['remote'], { allowFailure: true })
  if (!hasRemote.ok || !hasRemote.stdout.split('\n').map((line) => line.trim()).includes(remote)) {
    return { ok: false, stage: 'remote', error: `repository has no remote named ${remote}` }
  }

  const result = gitImpl(job.path, ['push', '-u', remote, job.branch], { allowFailure: true, env })
  if (!result.ok) return { ok: false, stage: 'push', error: result.error ?? 'git push failed' }
  return { ok: true, branch: job.branch, remote, output: result.stdout.split('\n').slice(-2).join(' ') }
}

function findCommand(command) {
  try {
    const path = execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim()
    return path === '' ? null : path
  } catch {
    return null
  }
}

export function prCommand({ job, title, body, base = 'main' }) {
  return [
    'gh',
    'pr',
    'create',
    '--draft',
    '--base',
    base,
    '--head',
    job.branch,
    '--title',
    title,
    '--body',
    body,
  ]
}

export function openDraftPr({ job, title, body, base = 'main', exec = execFileSync, find = findCommand }) {
  if (!jobBranchPattern(job.branch)) throw new Error(`refusing to open a PR for a non-job branch: ${job.branch}`)
  const gh = find('gh')
  if (!gh) {
    return {
      ok: false,
      stage: 'gh',
      error: 'gh CLI not found; install it or run the printed command yourself',
      command: prCommand({ job, title, body, base }).join(' '),
    }
  }
  if (typeof title !== 'string' || title.trim() === '') throw new Error('a PR title is required')
  const args = ['pr', 'create', '--draft', '--base', base, '--head', job.branch, '--title', title, '--body', body ?? '']
  try {
    const stdout = exec(gh, args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, url: String(stdout).trim().split('\n').pop(), draft: true }
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(0, 300)
    return { ok: false, stage: 'gh', error: detail || 'gh pr create failed' }
  }
}

export function describePublish(stage, result) {
  if (stage === 'commit') {
    if (!result.committed) return 'commit: nothing to commit'
    return `commit: ${result.commit.slice(0, 8)} on ${result.branch}`
  }
  if (stage === 'push') {
    if (!result.ok) return `push: failed at ${result.stage}: ${result.error}`
    return `push: ${result.branch} → ${result.remote}`
  }
  if (stage === 'pr') {
    if (result.ok) return `draft PR: ${result.url}`
    const lines = [`pr: failed at ${result.stage}: ${result.error}`]
    if (result.command) lines.push(`  run it yourself: ${result.command}`)
    return lines.join('\n')
  }
  return 'unknown stage'
}