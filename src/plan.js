/**
 * `station plan`: describe what the current profile would configure.
 *
 * Planning is read-only by design — it prints intended actions and their
 * prerequisites so the user can review before anything is installed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expandHome } from './probes.js'

export function loadProfile({ root, id }) {
  const path = join(root, 'profiles', `${id}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function buildPlan({ config, root }) {
  const profileId = config.machine?.profile ?? 'macos-apple-silicon'
  const profile = loadProfile({ root, id: profileId })
  const actions = []

  if (!profile) {
    return {
      profile: profileId,
      known: false,
      actions: [],
      notes: [`profile ${profileId} not found under profiles/`],
    }
  }

  for (const capabilityId of profile.capabilities ?? []) {
    const requires = profile.requirements?.[capabilityId] ?? []
    actions.push({
      capability: capabilityId,
      action: 'configure',
      requires,
      reason: requires.length > 0 ? `needs ${requires.join(', ')}` : 'no external requirement',
    })
  }

  const backup = config.storage?.backup
  if (backup?.enabled) {
    const targetPath = expandHome(backup.target?.path ?? '')
    actions.push({
      capability: 'backup',
      action: existsSync(targetPath) ? 'verify' : 'create-directory',
      requires: backup.target?.type === 'smb-restic' ? ['SMB mount', 'restic password'] : [],
      reason: `${backup.target?.type ?? 'local'} target at ${targetPath}`,
    })
  }

  if (config.remoteAccess?.enabled) {
    actions.push({
      capability: 'remote-access',
      action: 'configure',
      requires: ['Tailscale login'],
      reason: 'publishes selected local ports to the tailnet only',
    })
  }

  if (config.notifications?.primary && config.notifications.primary !== 'none') {
    actions.push({
      capability: 'notifications',
      action: 'not-implemented',
      requires: [config.notifications.primary],
      reason: 'connector lands in a later milestone; keep "none" for now',
    })
  }

  if (config.agent?.enabled) {
    actions.push({
      capability: 'agent',
      action: 'blocked',
      requires: ['isolated worktree runner', 'repo allowlist', 'budget limits'],
      reason: 'agent execution is intentionally unavailable in 0.1',
    })
  }

  const notes = []
  if (!config.storage?.backup?.enabled) notes.push('backup disabled: you will have no recoverable copy')
  if (profile.optional?.includes('nas')) {
    notes.push('NAS is optional: the profile works with a local or USB target')
  }

  return { profile: profile.id, known: true, actions, notes }
}

export function formatPlan(plan) {
  const lines = [`profile: ${plan.profile}${plan.known ? '' : ' (unknown)'}`]
  if (plan.actions.length === 0) lines.push('  no actions')
  for (const action of plan.actions) {
    const requires = action.requires.length > 0 ? ` [requires: ${action.requires.join(', ')}]` : ''
    lines.push(`  - ${action.capability}: ${action.action} — ${action.reason}${requires}`)
  }
  if (plan.notes.length > 0) {
    lines.push('', 'notes:')
    for (const note of plan.notes) lines.push(`  - ${note}`)
  }
  lines.push('', 'plan is read-only: nothing was installed or changed')
  return lines.join('\n')
}