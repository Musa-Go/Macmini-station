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
import { assertTrustedJob, gateConfig, readJobRecord, updateJobRecord, worktreeFingerprint } from './worktree.js'

/** Quote a value for safe copy-paste into a POSIX shell. */
export function shellQuote(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9_\-./:=@%+]+$/.test(text)) return text
  return `'${text.replaceAll("'", `'\\''`)}'`
}

function formatCommand(argv) {
  return argv.map(shellQuote).join(' ')
}

/**
 * Refuse to publish unless a passing gate run covers the exact working tree we
 * are about to commit. The record is re-read from disk (not trusted from the
 * caller) and tied to a content fingerprint.
 */
export function assertGate({ cwd, job, config, fingerprint }) {
  const gateSettings = gateConfig(config)
  const task = gateSettings.task
  if (!task) {
    if (gateSettings.required) {
      throw new Error('agent.gate.required is true but agent.gate.task is not set')
    }
    return { enforced: false, reason: 'no test gate configured (agent.gate.task); this commit is untested' }
  }
  const record = readJobRecord({ cwd, id: job.id })
  if (!record) throw new Error(`no trusted job record for ${job.id}`)
  const gate = record.gate
  if (!gate || gate.task !== task) {
    throw new Error(`run the gate task first: station worktree run ${job.id} --task ${task}`)
  }
  if (!gate.ok) {
    throw new Error(`gate task "${task}" did not pass (exit ${gate.exitCode ?? 'n/a'}); fix it before publishing`)
  }
  const current = fingerprint ?? worktreeFingerprint({ path: job.path })
  if (gate.fingerprint !== current) {
    throw new Error(`the working tree changed since the gate run; re-run: station worktree run ${job.id} --task ${task}`)
  }
  return { enforced: true, task, fingerprint: current }
}

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

export function commitJob({ cwd, job, message, config = {}, env, gitImpl = git, trust = assertTrustedJob }) {
  if (!jobBranchPattern(job.branch)) throw new Error(`refusing to commit on a non-job branch: ${job.branch}`)
  if (typeof message !== 'string' || message.trim() === '') throw new Error('a commit message is required')
  const trusted = trust({ cwd, job, gitImpl })
  const fingerprint = worktreeFingerprint({ path: trusted.path, gitImpl })
  const gate = assertGate({ cwd, job: trusted, config, fingerprint })
  const jobRef = trusted

  const status = gitImpl(jobRef.path, ['status', '--porcelain'])
  if (status.stdout === '') return { ok: true, committed: false, detail: 'nothing to commit' }

  gitImpl(jobRef.path, ['add', '-A'])
  const result = gitImpl(jobRef.path, [
    '-c',
    'user.name=macmini-station',
    '-c',
    'user.email=macmini-station@local',
    'commit',
    '-q',
    '-m',
    message.trim(),
  ], { env })
  const head = gitImpl(jobRef.path, ['rev-parse', 'HEAD']).stdout
  try {
    // Remember which commit the gate covered, so a later push can detect that the
    // branch moved after the tests passed.
    updateJobRecord({ cwd, id: jobRef.id, patch: { gateCommit: head, committedAt: new Date().toISOString() } })
  } catch {
    // Publishing still succeeds; push will then refuse because no gateCommit exists.
  }
  return { ok: true, committed: true, commit: head, branch: jobRef.branch, gate }
}

export function pushJob({ cwd, job, remote = 'origin', config = {}, env, gitImpl = git, trust = assertTrustedJob }) {
  if (!jobBranchPattern(job.branch)) throw new Error(`refusing to push a non-job branch: ${job.branch}`)
  const trusted = trust({ cwd, job, gitImpl })
  const gateSettings = gateConfig(config)
  if (gateSettings.task && gateSettings.required) {
    const gateTask = gateSettings.task
    const record = readJobRecord({ cwd, id: trusted.id })
    const gate = record?.gate
    const head = gitImpl(trusted.path, ['rev-parse', 'HEAD']).stdout
    if (!gate || !gate.ok) {
      throw new Error(`gate task "${gateTask}" has not passed; run it before pushing`)
    }
    const dirty = gitImpl(trusted.path, ['status', '--porcelain'], { allowFailure: true })
    if (dirty.ok && dirty.stdout !== '') {
      throw new Error('the worktree has uncommitted changes; commit or discard them before pushing')
    }
    const committedGate = record.gateCommit
    if (committedGate && committedGate !== head) {
      throw new Error(`the branch moved since the gate passed (${committedGate.slice(0, 8)} → ${head.slice(0, 8)}); re-run the gate`)
    }
  }

  const hasRemote = gitImpl(trusted.repo, ['remote'], { allowFailure: true })
  if (!hasRemote.ok || !hasRemote.stdout.split('\n').map((line) => line.trim()).includes(remote)) {
    return { ok: false, stage: 'remote', error: `repository has no remote named ${remote}` }
  }

  const result = gitImpl(trusted.path, ['push', '-u', remote, trusted.branch], { allowFailure: true, env })
  if (!result.ok) return { ok: false, stage: 'push', error: result.error ?? 'git push failed' }
  return { ok: true, branch: trusted.branch, remote, output: result.stdout.split('\n').slice(-2).join(' ') }
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

export function openDraftPr({ cwd, job, title, body, base = 'main', exec = execFileSync, find = findCommand, trust = assertTrustedJob, gitImpl = git }) {
  if (!jobBranchPattern(job.branch)) throw new Error(`refusing to open a PR for a non-job branch: ${job.branch}`)
  const trusted = trust({ cwd, job, gitImpl })
  const gh = find('gh')
  if (!gh) {
    return {
      ok: false,
      stage: 'gh',
      error: 'gh CLI not found; install it or run the printed command yourself',
      command: formatCommand(prCommand({ job: trusted, title, body, base })),
    }
  }
  if (typeof title !== 'string' || title.trim() === '') throw new Error('a PR title is required')
  const args = ['pr', 'create', '--draft', '--base', base, '--head', trusted.branch, '--title', title, '--body', body ?? '']
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