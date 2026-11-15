import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, configPath } from '../src/config.js'
import { createWorktree } from '../src/worktree.js'
import {
  MAX_CAPTURE_BYTES,
  allowedTasks,
  describeRun,
  readRuns,
  runAgent,
  runTask,
  tailBytes,
  taskLogPath,
} from '../src/jobrun.js'

function git(cwd, args) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function sandbox(commands = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'station-run-')))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])

  const station = join(dir, 'station')
  mkdirSync(station)
  const config = defaultConfig()
  config.agent = { enabled: true, workingDirectory: repo, tasks: commands, taskTimeoutSeconds: 30 }
  writeFileSync(configPath({ cwd: station }), JSON.stringify(config, null, 2))

  const job = createWorktree({ cwd: station, repo })
  return { dir, repo, station, config, job, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('allowedTasks returns an empty map when nothing is configured', () => {
  assert.deepEqual(allowedTasks(defaultConfig()), {})
})

test('tailBytes keeps short output and truncates long output from the front', () => {
  assert.equal(tailBytes('short'), 'short')
  const long = 'a'.repeat(20_000)
  const tail = tailBytes(long, 100)
  assert.ok(tail.startsWith('…(truncated)'))
  assert.ok(Buffer.byteLength(tail, 'utf8') <= 130)
})

test('runTask refuses an unknown task and lists the configured ones', () => {
  const s = sandbox({ test: ['node', '-e', 'process.exit(0)'] })
  try {
    assert.throws(
      () => runTask({ cwd: s.station, job: s.job, task: 'deploy', config: s.config }),
      /unknown task "deploy"; configured tasks: test/,
    )
  } finally {
    s.cleanup()
  }
})

test('runTask explains how to configure tasks when none exist', () => {
  const s = sandbox({})
  try {
    assert.throws(
      () => runTask({ cwd: s.station, job: s.job, task: 'test', config: s.config }),
      /no tasks configured/,
    )
  } finally {
    s.cleanup()
  }
})

test('runTask records a passing run, its log and its exit code', async () => {
  const s = sandbox({ test: ['node', '-e', 'console.log("all good")'] })
  try {
    const result = await runTask({ cwd: s.station, job: s.job, task: 'test', config: s.config })
    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.match(result.outputTail, /all good/)
    assert.ok(existsSync(result.logPath))
    assert.match(readFileSync(result.logPath, 'utf8'), /all good/)

    const runs = readRuns(s.station, s.job.id)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].exitCode, 0)
    assert.equal(runs[0].task, 'test')
    assert.equal(runs[0].outputTail, undefined, 'the jsonl record must not duplicate the output')
  } finally {
    s.cleanup()
  }
})

test('runTask treats a non-zero exit as data, not an exception', async () => {
  const s = sandbox({ test: ['node', '-e', 'console.error("boom"); process.exit(3)'] })
  try {
    const result = await runTask({ cwd: s.station, job: s.job, task: 'test', config: s.config })
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 3)
    assert.match(result.outputTail, /boom/)
    assert.match(describeRun(result), /failed \(exit 3\)/)
  } finally {
    s.cleanup()
  }
})

test('runTask kills the process group on timeout', async () => {
  const s = sandbox({ slow: ['node', '-e', 'setTimeout(()=>{}, 30000)'] })
  try {
    const started = Date.now()
    const result = await runTask({ cwd: s.station, job: s.job, task: 'slow', config: s.config, timeoutMs: 300 })
    const elapsed = Date.now() - started
    assert.equal(result.timedOut, true)
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, null)
    assert.ok(elapsed < 10_000, `should stop promptly, took ${elapsed}ms`)
    assert.match(describeRun(result), /timeout/)
  } finally {
    s.cleanup()
  }
})

test('runTask runs inside the worktree, not the station directory', async () => {
  const s = sandbox({ where: ['node', '-e', 'console.log(process.cwd())'] })
  try {
    const result = await runTask({ cwd: s.station, job: s.job, task: 'where', config: s.config })
    assert.ok(result.outputTail.includes(s.job.path), `expected ${s.job.path}, got ${result.outputTail}`)
  } finally {
    s.cleanup()
  }
})

test('runTask does not inherit parent secrets in the environment', async () => {
  const s = sandbox({ env: ['node', '-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'] })
  try {
    const result = await runTask({
      cwd: s.station,
      job: s.job,
      task: 'env',
      config: s.config,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: 'sk-should-not-leak', GITHUB_TOKEN: 'ghp_x' },
    })
    assert.ok(!result.outputTail.includes('OPENAI_API_KEY'))
    assert.ok(!result.outputTail.includes('GITHUB_TOKEN'))
    assert.ok(!result.outputTail.includes('sk-should-not-leak'))
  } finally {
    s.cleanup()
  }
})

test('runTask fails cleanly when the worktree has been removed', () => {
  const s = sandbox({ test: ['node', '-e', '0'] })
  try {
    rmSync(s.job.path, { recursive: true, force: true })
    assert.throws(
      () => runTask({ cwd: s.station, job: s.job, task: 'test', config: s.config }),
      /worktree is missing/,
    )
  } finally {
    s.cleanup()
  }
})

test('taskLogPath lives under .station/jobs/<id>', () => {
  const s = sandbox({})
  try {
    const path = taskLogPath(s.station, s.job.id, 'test')
    assert.ok(path.includes(join('.station', 'jobs', s.job.id)))
    assert.match(path, /test-.*\.log$/)
  } finally {
    s.cleanup()
  }
})
test('a very chatty task is capped in memory and in its log', async () => {
  const s = sandbox({ noisy: ['node', '-e', 'process.stdout.write("x".repeat(3*1024*1024))'] })
  try {
    const result = await runTask({ cwd: s.station, job: s.job, task: 'noisy', config: s.config, timeoutMs: 20_000 })
    assert.equal(result.ok, true)
    assert.ok(result.outputTail.length <= 9000, `tail should stay bounded, got ${result.outputTail.length}`)
    const log = readFileSync(result.logPath, 'utf8')
    // Cap plus the command header and the truncation marker.
    assert.ok(log.length <= MAX_CAPTURE_BYTES + 1024, `log file must be capped, got ${log.length}`)
    assert.match(log, /log truncated/)
  } finally {
    s.cleanup()
  }
})

test('an agent prompt is never written to the run record', async () => {
  const s = sandbox({})
  try {
    const config = { ...s.config, agent: { ...s.config.agent, command: ['node', '-e', 'console.log(process.argv[1])', '{prompt}'] } }
    const secretish = 'please paste the production token'
    const result = await runAgent({ cwd: s.station, job: s.job, prompt: secretish, config })
    assert.equal(result.ok, true)
    const runs = readRuns(s.station, s.job.id)
    const record = runs.at(-1)
    assert.ok(!JSON.stringify(record).includes(secretish), 'prompt must not be persisted in runs.jsonl')
    assert.match(JSON.stringify(record), /<prompt:/)
  } finally {
    s.cleanup()
  }
})
