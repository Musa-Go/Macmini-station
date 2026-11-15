/**
 * Controlled execution inside a prepared worktree (M4.2 / M4.3).
 *
 * Rules from docs/AGENT-JOBS.md:
 *   - only whitelisted argv arrays run, either a named task (`agent.tasks`) or
 *     the configured agent command (`agent.command`); nothing is inferred;
 *   - argv arrays are executed directly (no shell), so no interpolation exists;
 *   - each run has a timeout and is killed as a process group on expiry;
 *   - output is captured to a log file and only a bounded tail is reported;
 *   - the environment is reduced to PATH/HOME/LANG/TERM plus the variables the
 *     caller explicitly adds, so provider secrets in the parent process do not
 *     leak into a task;
 *   - the exit code is recorded; it is the only evidence later steps may use.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gateTaskName, jobsDir, worktreeFingerprint, updateJobRecord } from './worktree.js'

export const DEFAULT_TASK_TIMEOUT_SECONDS = 600
export const MAX_OUTPUT_TAIL_BYTES = 8000
// Hard ceiling on what a single run may hold in memory or write to its log.
export const MAX_CAPTURE_BYTES = 1024 * 1024

export function allowedTasks(config) {
  const tasks = config.agent?.tasks
  return tasks && typeof tasks === 'object' ? tasks : {}
}

export function runDir(cwd, jobId) {
  return join(jobsDir(cwd), jobId)
}

export function scrubbedEnv(env = process.env, extra = {}) {
  // Deliberately narrow: a build may need PATH and HOME, but it must not inherit
  // model/API credentials that happen to live in the parent process.
  return {
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: env.HOME ?? '',
    LANG: env.LANG ?? 'en_US.UTF-8',
    ...(env.TERM ? { TERM: env.TERM } : {}),
    ...extra,
  }
}

/** Keep the tail: failures and summaries cluster at the end of a log. */
export function tailBytes(text, limit = MAX_OUTPUT_TAIL_BYTES) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  if (buffer.length <= limit) return buffer.toString('utf8')
  return '…(truncated)\n' + buffer.subarray(buffer.length - limit).toString('utf8')
}

export function taskLogPath(cwd, jobId, label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  return join(runDir(cwd, jobId), `${label}-${stamp}.log`)
}

/**
 * Generic guarded process runner. Resolves with a structured result; a non-zero
 * exit is data, never an exception.
 */
export function runProcess({
  cwd,
  worktree,
  job,
  label,
  argv,
  timeoutMs,
  env = process.env,
  extraEnv = {},
  spawnImpl = spawn,
  record = {},
}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('argv must be a non-empty array')
  if (!existsSync(worktree)) throw new Error(`worktree is missing: ${worktree}`)

  mkdirSync(runDir(cwd, job.id), { recursive: true })
  const logPath = taskLogPath(cwd, job.id, label)
  const displayArgv = record.displayArgv ?? argv
  writeFileSync(logPath, `$ ${displayArgv.join(' ')}\n# cwd: ${worktree}\n\n`)

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawnImpl(argv[0], argv.slice(1), {
      cwd: worktree,
      env: scrubbedEnv(env, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let output = ''
    let loggedBytes = 0
    let logTruncated = false
    const collect = (chunk) => {
      const text = String(chunk)
      output += text
      if (output.length > MAX_CAPTURE_BYTES * 2) {
        // Keep a bounded window; tailBytes only needs the end of the stream.
        output = output.slice(-MAX_CAPTURE_BYTES)
      }
      if (logTruncated) return
      const bytes = Buffer.byteLength(text, 'utf8')
      if (loggedBytes + bytes > MAX_CAPTURE_BYTES) {
        logTruncated = true
        try {
          appendFileSync(logPath, '\n…(log truncated at 1 MiB; later output was dropped)\n')
        } catch {}
        return
      }
      loggedBytes += bytes
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
    }, timeoutMs)

    const finish = (code, signal, spawnError) => {
      clearTimeout(timer)
      const durationMs = Date.now() - startedAt
      const result = {
        jobId: job.id,
        kind: record.kind ?? label,
        label,
        argv: displayArgv,
        exitCode: timedOut || spawnError ? null : code,
        signal: signal ?? null,
        timedOut,
        ok: !timedOut && !spawnError && code === 0,
        durationMs,
        logPath,
        outputTail: tailBytes(output),
        ...record.extra,
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
      finish(null, null, error)
    })
    child.once('exit', (code, signal) => finish(code, signal))
  })
}

/**
 * Execute one whitelisted task (M4.2).
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
  return runProcess({
    cwd,
    worktree: job.path,
    job,
    label: task,
    argv,
    timeoutMs: timeoutMs ?? Math.max(1, seconds) * 1000,
    env,
    spawnImpl,
    record: { kind: 'task', extra: { task } },
  }).then((result) => {
    // A passing gate run is recorded against the exact tree content it tested,
    // so publishing can require that same content rather than a vague promise.
    if (gateTaskName(config) === task) {
      try {
        updateJobRecord({
          cwd,
          id: job.id,
          patch: {
            gate: {
              task,
              ok: result.ok,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              fingerprint: worktreeFingerprint({ path: job.path }),
              at: new Date().toISOString(),
            },
          },
        })
      } catch {
        // Recording failure must not change the run result, but publishing will
        // then refuse because no gate is on record.
      }
    }
    return result
  })
}

/** Fill {worktree} / {prompt} placeholders in the configured agent argv. */
export function renderAgentArgv(command, { worktree, prompt }) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error('agent.command must be a non-empty argv array, e.g. ["dsh","headless","{prompt}"]')
  }
  return command.map((part) =>
    String(part).replaceAll('{worktree}', worktree).replaceAll('{prompt}', prompt ?? ''),
  )
}

/** Execute the configured agent command inside the worktree (M4.3). */
export async function runAgent({ cwd, job, prompt, config, timeoutMs, env = process.env, spawnImpl = spawn }) {
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error('a prompt is required')
  const command = config.agent?.command
  const argv = renderAgentArgv(command, { worktree: job.path, prompt })
  const seconds = Number(config.agent?.taskTimeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS)
  return runProcess({
    cwd,
    worktree: job.path,
    job,
    label: 'agent',
    argv,
    timeoutMs: timeoutMs ?? Math.max(1, seconds) * 1000,
    env,
    spawnImpl,
    record: {
      kind: 'agent',
      // Never persist the prompt itself: it can contain private context.
      displayArgv: argv.map((part) => (part.includes(prompt) ? part.replaceAll(prompt, `<prompt:${prompt.length} chars>`) : part)),
      extra: { promptLength: prompt.length },
    },
  })
}

export function describeRun(result) {
  const status = result.timedOut ? 'timeout' : result.ok ? 'passed' : `failed (exit ${result.exitCode})`
  const seconds = (result.durationMs / 1000).toFixed(1)
  const lines = [`${result.label ?? result.task}: ${status} in ${seconds}s`, `  log: ${result.logPath}`]
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