/**
 * Remote access (M3.5): publish selected ports on the tailnet.
 *
 * Constraints from docs/CONNECTORS.md:
 *   - opt-in only: nothing is published unless remoteAccess.enabled is true and
 *     remoteAccess.ports lists the ports explicitly;
 *   - no bundled binaries: the Tailscale CLI is located, never downloaded;
 *   - no secrets: Tailscale owns its own credentials, this tool never sees them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { stateDir } from './state.js'

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

/** Ports this tool published previously, so it can reconcile instead of leaking. */
export function publishedFile(cwd) {
  return join(stateDir(cwd), 'expose.json')
}

export function readPublished({ cwd }) {
  const path = publishedFile(cwd)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed.ports) ? parsed.ports.filter((port) => Number.isInteger(port)) : []
  } catch {
    return []
  }
}

export function writePublished({ cwd, ports }) {
  mkdirSync(stateDir(cwd), { recursive: true })
  writeFileSync(publishedFile(cwd), `${JSON.stringify({ ports, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
    mode: 0o600,
  })
}

export function serveCommands(ports, { reset = false } = {}) {
  return ports.map((port) => (reset ? ['serve', `--https=${port}`, 'off'] : ['serve', '--bg', `--https=${port}`, 'http://127.0.0.1:' + port]))
}

/**
 * Publish or unpublish the configured ports. Returns a structured result.
 */
export function expose({ cwd, config, dryRun = false, off = false, probe = defaultProbe }) {
  const remote = config.remoteAccess ?? {}
  const enabled = remote.enabled === true
  const wanted = Array.isArray(remote.ports) ? remote.ports.filter((port) => Number.isInteger(port) && port > 0) : []
  const published = cwd ? readPublished({ cwd }) : []

  // `--off` must keep working after the user disables remote access; otherwise
  // turning the feature off could leave a published port behind.
  if (!enabled && !off) {
    return {
      ok: false,
      stage: 'config',
      error: 'remoteAccess.enabled is false; nothing is published (set it to true to opt in)',
    }
  }
  if (enabled && wanted.length === 0 && !off) {
    return { ok: false, stage: 'config', error: 'remoteAccess.ports is empty; list the ports to publish explicitly' }
  }

  const tailscale = findTailscale({ probe })
  if (!tailscale.ok) return { ok: false, stage: 'tailscale', ...tailscale }

  let toServe = []
  let toOff = []
  if (off) {
    // Only what this tool actually published (plus current config ports when the
    // feature is still enabled). A disabled config must not try to unpublish
    // ports it never served.
    toOff = [...new Set([...published, ...(enabled ? wanted : [])])]
    if (toOff.length === 0) {
      return { ok: true, off: true, ports: [], results: [], note: 'nothing recorded as published; nothing to unpublish' }
    }
  } else {
    toServe = wanted
    toOff = published.filter((port) => !wanted.includes(port))
  }

  const online = tailnetOnline({ path: tailscale.path, probe })
  if (!online.ok && toServe.length > 0) {
    return { ok: false, stage: 'tailnet', error: online.error, hint: 'run `tailscale up` and sign in first' }
  }

  const serveArgs = serveCommands(toServe)
  const offArgs = serveCommands(toOff, { reset: true })
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      tailscale: tailscale.path,
      commands: [...offArgs, ...serveArgs].map((args) => ['tailscale', ...args].join(' ')),
      wouldServe: toServe,
      wouldOff: toOff,
    }
  }

  const results = []
  for (let index = 0; index < offArgs.length; index += 1) {
    const result = probe(tailscale.path, offArgs[index])
    results.push({ port: toOff[index], action: 'off', ok: result.ok, ...(result.ok ? {} : { error: result.message ?? 'command failed' }) })
  }
  for (let index = 0; index < serveArgs.length; index += 1) {
    const result = probe(tailscale.path, serveArgs[index])
    results.push({ port: toServe[index], action: 'serve', ok: result.ok, ...(result.ok ? {} : { error: result.message ?? 'command failed' }) })
  }

  const failed = results.filter((result) => !result.ok)
  const allOk = failed.length === 0
  if (cwd && allOk) writePublished({ cwd, ports: off ? [] : toServe })

  return {
    ok: allOk,
    stage: allOk ? undefined : 'apply',
    tailscale: tailscale.path,
    ports: off ? toOff : toServe,
    off,
    results,
    ...(allOk ? {} : { error: `${failed.length} of ${results.length} tailscale command(s) failed` }),
  }
}

export function describeExpose(result) {
  if (result.ok && result.dryRun) {
    const lines = ['expose (dry run): nothing changed', `  tailscale: ${result.tailscale}`]
    for (const command of result.commands) lines.push(`  would run: ${command}`)
    return lines.join('\n')
  }
  if (result.ok && result.note) return `expose: ${result.note}`
  if (!result.ok) {
    const lines = [`expose: failed at ${result.stage}: ${result.error}`]
    if (result.hint) lines.push(`  fix: ${result.hint}`)
    return lines.join('\n')
  }
  const lines = [result.off ? 'expose: unpublished' : `expose: ${result.ports.length} port(s) published on the tailnet`]
  for (const item of result.results) {
    const action = item.action === 'off' ? 'off ' : 'serv'
    lines.push(`  ${item.ok ? 'ok  ' : 'fail'} ${action} :${item.port}${item.error ? ` (${item.error})` : ''}`)
  }
  return lines.join('\n')
}