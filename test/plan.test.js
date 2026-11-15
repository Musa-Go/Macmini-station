import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlan, formatPlan, loadProfile } from '../src/plan.js'
import { defaultConfig } from '../src/config.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('shipped profile lists capabilities without external requirements', () => {
  const profile = loadProfile({ root: ROOT, id: 'macos-apple-silicon' })
  assert.ok(profile)
  assert.deepEqual(profile.capabilities, ['local-backup', 'http-endpoint'])
  assert.deepEqual(profile.requirements['local-backup'], [])
})

test('plan is read-only and describes actions for the default config', () => {
  const config = defaultConfig()
  const plan = buildPlan({ config, root: ROOT })
  assert.equal(plan.known, true)
  assert.equal(plan.profile, 'macos-apple-silicon')
  assert.ok(plan.actions.length >= 2)
  assert.ok(plan.actions.some((a) => a.capability === 'backup'))
  assert.ok(plan.notes.some((n) => n.includes('optional')))
})

test('plan never claims to install during planning', () => {
  const config = defaultConfig()
  const text = formatPlan(buildPlan({ config, root: ROOT }))
  assert.match(text, /read-only/)
})

test('plan marks agent execution as blocked when enabled', () => {
  const config = defaultConfig()
  config.agent = { enabled: true, workingDirectory: '/tmp/project' }
  const plan = buildPlan({ config, root: ROOT })
  const agentAction = plan.actions.find((a) => a.capability === 'agent')
  assert.equal(agentAction.action, 'blocked')
})

test('plan warns when backup is disabled', () => {
  const config = defaultConfig()
  config.storage.backup.enabled = false
  const plan = buildPlan({ config, root: ROOT })
  assert.ok(plan.notes.some((n) => n.includes('no recoverable copy')))
})

test('unknown profile is reported instead of guessed', () => {
  const config = defaultConfig()
  config.machine.profile = 'does-not-exist'
  const plan = buildPlan({ config, root: ROOT })
  assert.equal(plan.known, false)
  assert.equal(plan.actions.length, 0)
})