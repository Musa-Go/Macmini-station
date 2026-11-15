/**
 * Controlled task execution inside a prepared worktree (M4.2).
 *
 * Rules from docs/AGENT-JOBS.md:
 *   - only tasks named in `agent.tasks` can run; nothing is inferred;
 *   - argv arrays are executed directly (no shell), so no interpolation exists;
 *   - each run has a timeout and is killed as a process group on expiry;
 *   - output is captured to a log file and only a bounded tail is reported;
 *   - the environment is reduced to PATH/HOME/LANG, so provider secrets in the
 *     parent process do not leak into a task;
 *   - the result records the exit code, which is the only evidence a later step
 *     (M4.3/M4.4) may use to decide whether a change is acceptable.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { jobsDir } from './worktree.js'

export const DEFAULT_TASK_TIMEOUT_SECONDS = 600
export const MAX_OUTPUT_TAIL_BYTES = 8000

export function allowedTasks(config) {
  const tasks = config.agent?.tasks
  return tasks && typeof tasks === 'object' ? tasks : {}
}

export function runDir(cwd, jobId) {
  return join(jobsDir(cwd), jobId)
}

function scrubbedEnv(env = process.env) {
  // Deliberately narrow: a build may need PATH and HOME, but it must not inherit
  // model/API credentials that happen to live in the parent process.
  return {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: env.HOME ?? '',
    LANG: env.LANG ?? 'en_US.UTF-8',
    ...(env.TERM ? { TERM: env.TERM } : {}),
  }
}

/** Keep the tail: failures and summaries cluster at the end of a log. */
export function tailBytes(text, limit = MAX_OUTPUT_TAIL_BYTES) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  if (buffer.length <= limit) return buffer.toString('utf8')
  return '…(truncated)\n' + buffer.subarray(buffer.length - limit).toString('utf8')
}

export function taskLogPath(cwd, jobId, task) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return join(runDir(cwd, jobId), `${task}-${stamp}.log`)
}

/**
 * Execute one whitelisted task in the worktree. Resolves with a structured
 * result; a non-zero exit is data, not an exception.
 */
export function runTask({ cwd, job, task, config, timeoutMs, env = process.env, spawnImpl = spawn }) {
  const tasks = allowedTasks(config)
  const argv = tasks[task]
  if (!Array.isArray(argv) || argv.length === 0) {
    const known = Object.keys(tasks)
    throw new Error(
      known.length === 0
        ? `no tasks configured; add agent.tasks to station.json (e.g. {"test": ["npm","test"]})`
        : `unknown task "${task}"; configured tasks: ${known.join(', ')}`,
    )
  }

  const seconds = Number(config.agent?.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS)
  const limitMs = timeoutMs ?? Math.max(1, seconds) * 1000
  const worktree = job.path
  if (!existsSync(worktree)) throw new Error(`worktree is missing: ${worktree}`)

  mkdirSync(runDir(cwd, job.id), { recursive: true })
  const logPath = taskLogPath(cwd, job.id, task)
  writeFileSync(logPath, `$ ${argv.join(' ')}\n# cwd: ${worktree}\n\n`)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawnImpl(argv[0], argv.slice(1), {
      cwd: worktree,
      env: scrubbedEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let output = ''
    const collect = (chunk) => {
      const text = String(chunk)
      output += text
      try {
        appendFileSync(logPath, text)
      } catch {
        // Logging must not break execution.
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }, limitMs)

    const finish = (code, signal) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      const result = {
        jobId: job.id,
        task,
        argv,
        exitCode: timedOut ? null : code,
        signal: signal ?? null,
        timedOut,
        ok: !timedOut && code === 0,
        durationMs,
        logPath,
        outputTail: tailBytes(output),
      }
      try {
        appendFileSync(
          join(runDir(cwd, job.id), 'runs.jsonl'),
          `${JSON.stringify({ ...result, outputTail: undefined })}\n`,
        )
      } catch {}
      resolve(result)
    }

    child.once('error', (error) => {
      collect(`\n[spawn error] ${error instanceof Error ? error.message : String(error)}\n`)
      finish(null, null)
    })
    child.once('exit', (code, signal) => finish(code, signal))
  })
}

export function describeRun(result) {
  const status = result.timedOut ? 'timeout' : result.ok ? 'passed' : `failed (exit ${result.exitCode})`
  const seconds = (result.durationMs / 1000).toFixed(1)
  const lines = [`${result.task}: ${status} in ${seconds}s`, `  log: ${result.logPath}`]
  if (result.outputTail.trim() !== '') {
    lines.push('  --- output tail ---')
    for (const line of result.outputTail.trimEnd().split('\n').slice(-12)) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}

export function readRuns(cwd, jobId) {
  const path = join(runDir(cwd, jobId), 'runs.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}