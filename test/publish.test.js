import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, configPath } from '../src/config.js'
import { createWorktree } from '../src/worktree.js'
import { describeRun, renderAgentArgv, runAgent, scrubbedEnv } from '../src/jobrun.js'
import { commitJob, describePublish, jobBranchPattern, openDraftPr, prCommand, pushJob } from '../src/publish.js'
import { jobsDir, readJobRecord, updateJobRecord, worktreeFingerprint } from '../src/worktree.js'

function git(cwd, args) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function sandbox({ withCommand = true, withRemote = false, gate } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'station-pub-')))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, ['add', '.'])
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'])

  if (withRemote) {
    const bare = join(dir, 'remote.git')
    execFileSync('/usr/bin/git', ['init', '-q', '--bare', bare], { encoding: 'utf8' })
    git(repo, ['remote', 'add', 'origin', bare])
  }

  const station = join(dir, 'station')
  mkdirSync(station)
  const config = defaultConfig()
  config.agent = {
    enabled: true,
    workingDirectory: repo,
    taskTimeoutSeconds: 20,
    tasks: { test: ['node', '-e', 'process.exit(0)'] },
    ...(withCommand ? { command: ['node', '-e', 'console.log("agent saw: " + process.argv[1])', '{prompt}'] } : {}),
    ...(gate ? { gate } : {}),
  }
  writeFileSync(configPath({ cwd: station }), JSON.stringify(config, null, 2))

  const job = createWorktree({ cwd: station, repo })
  return { dir, repo, station, config, job, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('renderAgentArgv substitutes placeholders without shell interpretation', () => {
  const argv = renderAgentArgv(['dsh', 'headless', '{prompt}', '--cwd', '{worktree}'], {
    worktree: '/tmp/wt',
    prompt: 'fix the bug; rm -rf /',
  })
  assert.deepEqual(argv, ['dsh', 'headless', 'fix the bug; rm -rf /', '--cwd', '/tmp/wt'])
})

test('renderAgentArgv rejects a missing command', () => {
  assert.throws(() => renderAgentArgv(undefined, { worktree: '/w', prompt: 'x' }), /agent.command/)
  assert.throws(() => renderAgentArgv([], { worktree: '/w', prompt: 'x' }), /agent.command/)
})

test('runAgent executes the configured command inside the worktree', async () => {
  const s = sandbox()
  try {
    const result = await runAgent({ cwd: s.station, job: s.job, prompt: 'hello world', config: s.config })
    assert.equal(result.ok, true)
    assert.equal(result.kind, 'agent')
    assert.match(result.outputTail, /agent saw: hello world/)
    assert.equal(result.promptLength, 11)
  } finally {
    s.cleanup()
  }
})

test('runAgent refuses without a prompt and without a command', async () => {
  const s = sandbox({ withCommand: false })
  try {
    await assert.rejects(() => runAgent({ cwd: s.station, job: s.job, prompt: '', config: s.config }), /prompt is required/)
    await assert.rejects(() => runAgent({ cwd: s.station, job: s.job, prompt: 'x', config: s.config }), /agent.command/)
  } finally {
    s.cleanup()
  }
})

test('scrubbedEnv keeps only the allowlist plus explicit extras', () => {
  const env = scrubbedEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'sk', GITHUB_TOKEN: 'ghp' }, { STATION_JOB: '1' })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'STATION_JOB'])
})

test('jobBranchPattern only accepts station/job-* branches', () => {
  assert.equal(jobBranchPattern('station/job-abc'), true)
  assert.equal(jobBranchPattern('main'), false)
  assert.equal(jobBranchPattern('feature/x'), false)
  assert.equal(jobBranchPattern(undefined), false)
})

test('commitJob commits inside the worktree and never on a non-job branch', () => {
  const s = sandbox()
  try {
    writeFileSync(join(s.job.path, 'fix.txt'), 'fixed\n')
    const result = commitJob({ cwd: s.station, config: s.config, job: s.job, message: 'fix: add fix.txt' })
    assert.equal(result.committed, true)
    assert.match(git(s.job.path, ['log', '-1', '--pretty=%s']), /fix: add fix\.txt/)

    assert.throws(
      () => commitJob({ cwd: s.station, config: s.config, job: { ...s.job, branch: 'main' }, message: 'x' }),
      /non-job branch/,
    )
    assert.throws(() => commitJob({ cwd: s.station, config: s.config, job: s.job, message: '  ' }), /commit message is required/)
  } finally {
    s.cleanup()
  }
})

test('commitJob reports nothing to commit instead of failing', () => {
  const s = sandbox()
  try {
    const result = commitJob({ cwd: s.station, config: s.config, job: s.job, message: 'noop' })
    assert.equal(result.committed, false)
    assert.match(describePublish('commit', result), /nothing to commit/)
  } finally {
    s.cleanup()
  }
})

test('pushJob refuses without a remote and pushes the job branch when one exists', () => {
  const noRemote = sandbox()
  try {
    const result = pushJob({ cwd: noRemote.station, config: noRemote.config, job: noRemote.job })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'remote')
  } finally {
    noRemote.cleanup()
  }

  const withRemote = sandbox({ withRemote: true })
  try {
    writeFileSync(join(withRemote.job.path, 'fix.txt'), 'x\n')
    commitJob({ cwd: withRemote.station, config: withRemote.config, job: withRemote.job, message: 'fix: change' })
    const result = pushJob({ cwd: withRemote.station, config: withRemote.config, job: withRemote.job })
    assert.equal(result.ok, true, JSON.stringify(result))
    const remoteBranches = execFileSync('/usr/bin/git', ['-C', join(withRemote.dir, 'remote.git'), 'branch', '--list'], { encoding: 'utf8' })
    assert.match(remoteBranches, /station\/job-/)
  } finally {
    withRemote.cleanup()
  }
})

test('pushJob refuses a non-job branch', () => {
  const s = sandbox({ withRemote: true })
  try {
    assert.throws(() => pushJob({ cwd: s.station, config: s.config, job: { ...s.job, branch: 'main' } }), /non-job branch/)
  } finally {
    s.cleanup()
  }
})

test('openDraftPr returns the command to run when gh is missing', () => {
  const s = sandbox()
  try {
    const result = openDraftPr({ cwd: s.station, job: s.job, title: 't', body: 'b', find: () => null })
    assert.equal(result.ok, false)
    assert.equal(result.stage, 'gh')
    assert.match(result.command, /gh pr create --draft/)
    assert.match(result.command, new RegExp(s.job.branch))
  } finally {
    s.cleanup()
  }
})

test('openDraftPr creates a draft and never a ready PR', () => {
  const s = sandbox()
  try {
    const calls = []
    const exec = (command, args) => {
      calls.push({ command, args })
      return 'https://github.com/x/y/pull/1\n'
    }
    const result = openDraftPr({
      cwd: s.station,
      job: s.job,
      title: 'feat: x',
      body: 'body',
      exec,
      find: () => '/usr/local/bin/gh',
    })
    assert.equal(result.ok, true)
    assert.equal(result.draft, true)
    assert.match(result.url, /pull\/1/)
    assert.ok(calls[0].args.includes('--draft'))
    assert.ok(!calls[0].args.includes('--merge'))
  } finally {
    s.cleanup()
  }
})

test('openDraftPr refuses a non-job branch and requires a title', () => {
  const s = sandbox()
  try {
    assert.throws(
      () => openDraftPr({ cwd: s.station, job: { ...s.job, branch: 'main' }, title: 't', find: () => '/gh' }),
      /non-job branch/,
    )
    assert.throws(() => openDraftPr({ cwd: s.station, job: s.job, title: '  ', find: () => '/gh' }), /PR title is required/)
  } finally {
    s.cleanup()
  }
})

test('prCommand is a plain gh invocation with --draft', () => {
  const argv = prCommand({ job: { branch: 'station/job-x' }, title: 't', body: 'b' })
  assert.deepEqual(argv.slice(0, 4), ['gh', 'pr', 'create', '--draft'])
})

test('describeRun reports agent runs like tasks', () => {
  const text = describeRun({ label: 'agent', ok: true, durationMs: 1200, logPath: '/tmp/x.log', outputTail: 'done' })
  assert.match(text, /agent: passed/)
  assert.match(text, /done/)
})
test('commit refuses a job record whose path was redirected at the source repo', () => {
  const s = sandbox()
  try {
    writeFileSync(join(s.repo, 'injected.txt'), 'should never be committed\n')
    const recordPath = join(jobsDir(s.station), `${s.job.id}.json`)
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    writeFileSync(recordPath, JSON.stringify({ ...record, path: s.repo }, null, 2))

    assert.throws(
      () => commitJob({ cwd: s.station, config: s.config, job: { ...s.job, path: s.repo }, message: 'forged' }),
      /no trusted job record|not the worktree directory/,
    )
    assert.equal(git(s.repo, ['log', '-1', '--pretty=%s']), 'init', 'the source repository must be untouched')
  } finally {
    s.cleanup()
  }
})

test('a configured gate blocks commit until the exact tree passes', () => {
  const s = sandbox({ gate: { task: 'test' } })
  try {
    writeFileSync(join(s.job.path, 'added.txt'), 'x\n')
    assert.throws(
      () => commitJob({ cwd: s.station, config: s.config, job: s.job, message: 'no gate yet' }),
      /run the gate task first/,
    )

    const record = readJobRecord({ cwd: s.station, id: s.job.id })
    updateJobRecord({
      cwd: s.station,
      id: s.job.id,
      patch: {
        gate: { task: 'test', ok: true, exitCode: 0, fingerprint: 'stale-fingerprint', at: new Date().toISOString() },
      },
    })
    assert.ok(record)
    assert.throws(
      () => commitJob({ cwd: s.station, config: s.config, job: s.job, message: 'stale gate' }),
      /working tree changed since the gate run/,
    )

    updateJobRecord({
      cwd: s.station,
      id: s.job.id,
      patch: {
        gate: {
          task: 'test',
          ok: true,
          exitCode: 0,
          fingerprint: worktreeFingerprint({ path: s.job.path }),
          at: new Date().toISOString(),
        },
      },
    })
    const result = commitJob({ cwd: s.station, config: s.config, job: s.job, message: 'gated commit' })
    assert.equal(result.committed, true)
    assert.equal(result.gate.enforced, true)
  } finally {
    s.cleanup()
  }
})

test('an untested commit is allowed only when no gate is configured, and says so', () => {
  const s = sandbox()
  try {
    writeFileSync(join(s.job.path, 'file.txt'), 'x\n')
    const result = commitJob({ cwd: s.station, config: s.config, job: s.job, message: 'ungated' })
    assert.equal(result.gate.enforced, false)
    assert.match(result.gate.reason, /no test gate configured/)
  } finally {
    s.cleanup()
  }
})
