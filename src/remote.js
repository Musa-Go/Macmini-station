/**
 * Remote access (M3.5): publish selected ports on the tailnet.
 *
 * Constraints from docs/CONNECTORS.md:
 *   - opt-in only: nothing is published unless remoteAccess.enabled is true and
 *     remoteAccess.ports lists the ports explicitly;
 *   - no bundled binaries: the Tailscale CLI is located, never downloaded;
 *   - no secrets: Tailscale owns its own credentials, this tool never sees them.
 */

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const TAILSCALE_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]

export function findTailscale({ exists = existsSync, probe = defaultProbe } = {}) {
  for (const candidate of TAILSCALE_CANDIDATES) {
    if (!exists(candidate)) continue
    const result = probe(candidate, ['version'])
    if (result.ok) return { ok: true, path: candidate, version: result.stdout.split('\n')[0] }
  }
  return {
    ok: false,
    error: 'tailscale CLI not found',
    hint: 'install Tailscale and sign in, or set remoteAccess.enabled=false to stay local-only',
  }
}

function defaultProbe(command, args) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: String(stdout).trim(), code: 0 }
  } catch (error) {
    return { ok: false, stdout: '', code: typeof error?.status === 'number' ? error.status : null, message: String(error?.message ?? error) }
  }
}

/** `tailscale status` must show a node with an address, i.e. the device is online. */
export function tailnetOnline({ path, probe }) {
  const result = probe(path, ['status'])
  if (!result.ok) return { ok: false, error: `tailscale status failed: ${result.message ?? 'unknown error'}` }
  const text = result.stdout
  if (/Logged out|NeedsLogin/i.test(text)) {
    return { ok: false, error: 'tailscale is logged out; sign in before publishing ports' }
  }
  const hasAddress = /\b\d{1,3}(\.\d{1,3}){3}\b/.test(text) || /\bfd[0-9a-f]{2}:/i.test(text)
  if (!hasAddress) return { ok: false, error: 'tailscale status shows no tailnet address' }
  return { ok: true }
}

export function serveCommands(ports, { reset = false } = {}) {
  return ports.map((port) => (reset ? ['serve', `--https=${port}`, 'off'] : ['serve', '--bg', `--https=${port}`, 'http://127.0.0.1:' + port]))
}

/**
 * Publish or unpublish the configured ports. Returns a structured result.
 */
export function expose({ config, dryRun = false, off = false, probe = defaultProbe }) {
  const remote = config.remoteAccess ?? {}
  if (remote.enabled !== true) {
    return {
      ok: false,
      stage: 'config',
      error: 'remoteAccess.enabled is false; nothing is published (set it to true to opt in)',
    }
  }
  const ports = Array.isArray(remote.ports) ? remote.ports.filter((p) => Number.isInteger(p) && p > 0) : []
  if (ports.length === 0) {
    return { ok: false, stage: 'config', error: 'remoteAccess.ports is empty; list the ports to publish explicitly' }
  }

  const tailscale = findTailscale({ probe })
  if (!tailscale.ok) return { ok: false, stage: 'tailscale', ...tailscale }

  const online = tailnetOnline({ path: tailscale.path, probe })
  if (!online.ok && !off) {
    return { ok: false, stage: 'tailnet', error: online.error, hint: 'run `tailscale up` and sign in first' }
  }

  const commands = serveCommands(ports, { reset: off })
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      tailscale: tailscale.path,
      commands: commands.map((args) => ['tailscale', ...args].join(' ')),
    }
  }

  const results = []
  for (let index = 0; index < commands.length; index += 1) {
    const args = commands[index]
    const result = probe(tailscale.path, args)
    results.push({ port: ports[index], ok: result.ok, ...(result.ok ? {} : { error: result.message ?? 'command failed' }) })
  }

  const failed = results.filter((r) => !r.ok)
  return {
    ok: failed.length === 0,
    stage: failed.length === 0 ? undefined : 'apply',
    tailscale: tailscale.path,
    ports,
    results,
    ...(failed.length === 0 ? {} : { error: `${failed.length} of ${results.length} serve command(s) failed` }),
  }
}

export function describeExpose(result) {
  if (result.ok && result.dryRun) {
    const lines = ['expose (dry run): nothing published', `  tailscale: ${result.tailscale}`]
    for (const command of result.commands) lines.push(`  would run: ${command}`)
    return lines.join('\n')
  }
  if (!result.ok) {
    const lines = [`expose: failed at ${result.stage}: ${result.error}`]
    if (result.hint) lines.push(`  fix: ${result.hint}`)
    return lines.join('\n')
  }
  const lines = [`expose: ${result.ports.length} port(s) published on the tailnet`]
  for (const item of result.results) lines.push(`  ${item.ok ? 'ok  ' : 'fail'} :${item.port}${item.error ? ` (${item.error})` : ''}`)
  return lines.join('\n')
}