/**
 * `station doctor`: a read-only diagnosis of the machine and the install.
 *
 * Each check returns { id, title, status, detail, fix? } where status is one of
 * ok | warn | critical | unknown. Nothing here installs, writes or starts
 * services; the command is safe to run at any time.
 */

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, loadConfig, configPath } from './config.js'
import { run, mountProbe, expandHome } from './probes.js'
import { findRestic } from './backup.js'

const MIN_NODE_MAJOR = 20

export function runDoctor({ cwd, env = process.env, root }) {
  const checks = []
  // Defaults are evaluated on purpose: a machine that has not run `init` still
  // gets a full picture (backup, remote, notifications) instead of silence.
  const config = safeConfig({ cwd }) ?? defaultConfig()

  checks.push(checkNode())
  checks.push(checkPlatform())
  checks.push(checkConfigFile({ cwd }))

  checks.push(checkBackupTarget({ config }))
  checks.push(checkRestic({ config }))
  checks.push(checkRemoteAccess({ config }))
  checks.push(checkNotifications({ config }))
  checks.push(checkAgent({ config }))

  checks.push(checkGit())
  checks.push(checkDocker())
  checks.push(checkProfile({ root, config }))

  return checks
}

function safeConfig({ cwd }) {
  if (!existsSync(configPath({ cwd }))) return null
  try {
    return loadConfig({ cwd })
  } catch {
    return null
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  const ok = major >= MIN_NODE_MAJOR
  return {
    id: 'node',
    title: 'Node.js',
    status: ok ? 'ok' : 'critical',
    detail: `v${process.versions.node} (need >= ${MIN_NODE_MAJOR})`,
    ...(ok ? {} : { fix: `install Node.js ${MIN_NODE_MAJOR}+ (e.g. \`brew install node@22\`)` }),
  }
}

function checkPlatform() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin' && arch === 'arm64') {
    return { id: 'platform', title: 'Platform', status: 'ok', detail: `macOS ${arch}` }
  }
  if (platform === 'darwin') {
    return {
      id: 'platform',
      title: 'Platform',
      status: 'warn',
      detail: `macOS ${arch}`,
      fix: 'Apple Silicon is the supported first-class target; Intel support is best-effort',
    }
  }
  return {
    id: 'platform',
    title: 'Platform',
    status: 'warn',
    detail: `${platform} ${arch}`,
    fix: 'only macOS is validated by the core profile today; other platforms need their own adapters',
  }
}

function checkConfigFile({ cwd }) {
  const path = configPath({ cwd })
  if (!existsSync(path)) {
    return {
      id: 'config',
      title: 'station.json',
      status: 'warn',
      detail: 'not found, defaults in use',
      fix: 'run `station init` to write a config you can edit',
    }
  }
  try {
    const config = loadConfig({ cwd })
    return { id: 'config', title: 'station.json', status: 'ok', detail: `valid at ${path}` }
  } catch (error) {
    return {
      id: 'config',
      title: 'station.json',
      status: 'critical',
      detail: error instanceof Error ? error.message : String(error),
      fix: 'fix the reported field or delete the file and run `station init`',
    }
  }
}

function checkBackupTarget({ config }) {
  if (!config.storage?.backup?.enabled) {
    return {
      id: 'backup',
      title: 'Backup',
      status: 'warn',
      detail: 'disabled in config',
      fix: 'enable storage.backup; local disk or an external disk is enough, NAS is optional',
    }
  }
  const target = config.storage.backup.target
  if (target.type === 'local') {
    const path = expandHome(target.path)
    if (!existsSync(path)) {
      return {
        id: 'backup',
        title: 'Backup target',
        status: 'warn',
        detail: `${path} does not exist yet`,
        fix: 'create the directory (planned: `station apply` creates it) or point the path elsewhere',
      }
    }
    return { id: 'backup', title: 'Backup target', status: 'ok', detail: `local path ${path}` }
  }
  if (target.type === 'external-disk') {
    const path = expandHome(target.path)
    return {
      id: 'backup',
      title: 'Backup target',
      status: existsSync(path) ? 'ok' : 'warn',
      detail: existsSync(path) ? `external disk mounted at ${path}` : `external disk not mounted: ${path}`,
      ...(existsSync(path) ? {} : { fix: 'attach the disk, or change storage.backup.target.path' }),
    }
  }
  if (target.type === 'smb-restic') {
    const mount = mountProbe({ path: target.path })
    return {
      id: 'backup',
      title: 'Backup target',
      status: mount.ok ? 'ok' : 'warn',
      detail: mount.detail,
      ...(mount.ok ? {} : { fix: 'mount the SMB share, or switch to a local target — NAS is optional' }),
    }
  }
  return { id: 'backup', title: 'Backup target', status: 'unknown', detail: `type ${target.type} not implemented in 0.1` }
}

function checkRestic({ config }) {
  const backup = config.storage?.backup
  if (!backup?.enabled) {
    return { id: 'restic', title: 'restic', status: 'ok', detail: 'backup disabled' }
  }
  const restic = findRestic()
  if (restic.ok) {
    return { id: 'restic', title: 'restic', status: 'ok', detail: `${restic.path} (${restic.version ?? 'version unknown'})` }
  }
  return {
    id: 'restic',
    title: 'restic',
    status: 'warn',
    detail: restic.error ?? 'restic not found',
    fix: restic.hint ?? 'install restic; the tool never bundles a binary',
  }
}

function checkRemoteAccess({ config }) {
  if (!config.remoteAccess?.enabled) {
    return { id: 'remote', title: 'Remote access', status: 'ok', detail: 'disabled (local-only)' }
  }
  const hasTailscale = existsSync('/Applications/Tailscale.app') || run('which', ['tailscale']).ok
  return {
    id: 'remote',
    title: 'Remote access',
    status: hasTailscale ? 'ok' : 'warn',
    detail: hasTailscale ? 'Tailscale detected' : 'remoteAccess enabled but Tailscale not found',
    ...(hasTailscale ? {} : { fix: 'install Tailscale, or set remoteAccess.enabled to false' }),
  }
}

function checkNotifications({ config }) {
  const primary = config.notifications?.primary ?? 'none'
  if (primary === 'none') {
    return { id: 'notifications', title: 'Notifications', status: 'ok', detail: 'disabled' }
  }
  return {
    id: 'notifications',
    title: 'Notifications',
    status: 'warn',
    detail: `${primary} adapter not implemented in 0.1`,
    fix: 'keep "none" until the connector milestone lands',
  }
}

function checkAgent({ config }) {
  if (!config.agent?.enabled) {
    return { id: 'agent', title: 'Agent jobs', status: 'ok', detail: 'disabled (no automated code execution)' }
  }
  const dir = String(config.agent.workingDirectory ?? '')
  return {
    id: 'agent',
    title: 'Agent jobs',
    status: 'warn',
    detail: `enabled for ${dir || '(unset)'}, runner not implemented in 0.1`,
    fix: 'leave agent.enabled false until the isolated worktree runner exists',
  }
}

function checkGit() {
  const result = run('git', ['--version'])
  return {
    id: 'git',
    title: 'git',
    status: result.ok ? 'ok' : 'warn',
    detail: result.ok ? result.stdout : 'git not found',
    ...(result.ok ? {} : { fix: 'install git (Xcode command line tools): `xcode-select --install`' }),
  }
}

function checkDocker() {
  const docker = run('docker', ['--version'])
  if (!docker.ok) {
    return {
      id: 'docker',
      title: 'Container runtime',
      status: 'ok',
      detail: 'not installed (optional)',
    }
  }
  return { id: 'docker', title: 'Container runtime', status: 'ok', detail: docker.stdout }
}

function checkProfile({ root, config }) {
  const profileId = config?.machine?.profile
  if (!profileId) {
    return { id: 'profile', title: 'Profile', status: 'ok', detail: 'default profile' }
  }
  const path = join(root, 'profiles', `${profileId}.json`)
  if (!existsSync(path)) {
    return {
      id: 'profile',
      title: 'Profile',
      status: 'warn',
      detail: `unknown profile: ${profileId}`,
      fix: 'pick one of the shipped profiles in profiles/',
    }
  }
  const profile = JSON.parse(readFileSync(path, 'utf8'))
  return { id: 'profile', title: 'Profile', status: 'ok', detail: `${profile.id} (${profile.capabilities.length} capabilities)` }
}

export function formatChecks(checks) {
  const icon = { ok: '[ok]  ', warn: '[warn]', critical: '[fail]', unknown: '[??]  ' }
  const lines = checks.map((c) => `${icon[c.status] ?? '[??]  '} ${c.title.padEnd(20)} ${c.detail}`)
  const problems = checks.filter((c) => c.status !== 'ok')
  if (problems.length > 0) {
    lines.push('')
    lines.push('Fixes:')
    for (const problem of problems) lines.push(`  - ${problem.title}: ${problem.fix ?? 'see detail'}`)
  }
  const summary = summarizeChecks(checks)
  lines.push('')
  lines.push(`ok ${summary.ok} · warn ${summary.warn} · critical ${summary.critical} · unknown ${summary.unknown}`)
  return lines.join('\n')
}

export function summarizeChecks(checks) {
  const summary = { ok: 0, warn: 0, critical: 0, unknown: 0 }
  for (const check of checks) summary[check.status] = (summary[check.status] ?? 0) + 1
  return summary
}