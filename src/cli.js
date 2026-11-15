/**
 * Command-line entry for Macmini-station.
 *
 * Kept dependency-free on purpose: the toolkit must be runnable on a fresh Mac
 * with nothing but Node installed, so every command works without `npm install`.
 */

import { loadConfig, writeDefaultConfig, configPath } from './config.js'
import { runDoctor, formatChecks } from './doctor.js'
import { loadCapabilities, probeCapabilities, formatCapabilityTable } from './capabilities.js'
import { buildPlan, formatPlan } from './plan.js'
import { backup, check, findRestic, restore, INSTALL_HINT } from './backup.js'
import { describeNotify, notify } from './notify.js'
import { describeExpose, expose } from './remote.js'
import {
  apply,
  describeApply,
  describeRollback,
  describeVerify,
  rollback,
  verify,
} from './apply.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export const EXIT_OK = 0
export const EXIT_WARN = 1
export const EXIT_FAIL = 2

const USAGE = `station — Mac mini workstation toolkit

Usage:
  station doctor [--json]        Check this machine and print a diagnosis
  station status [--json]        Probe every registered capability
  station plan [--json]          Show what this profile would configure (no changes)
  station apply [--dry-run] [--json]
                                 Create the directories this profile needs (never starts services)
  station verify [--json]        Re-check applied state and config drift
  station rollback [--to <id>] [--dry-run] [--json]
                                 Remove only paths a previous apply created
  station backup [--dry-run] [--json]
                                 Back up state + config with a restic you installed (never bundled)
  station backup check [--json]  Verify repository integrity
  station backup restore --into <dir> [--json]
                                 Restore the latest snapshot into a directory (recovery drill)
  station notify --title <t> --body <b> [--dry-run] [--json]
                                 Deliver through the configured connector (bark or QQ)
  station expose [--dry-run] [--off] [--json]
                                 Publish remoteAccess.ports on the tailnet via tailscale serve
  station init [--force]         Write a default station.json
  station version                Print version
  station help                   Show this help

Exit codes: 0 ok, 1 warnings, 2 failures or bad usage.
Configuration: ./station.json (see schema/station.schema.json).
`

function parseArgs(argv) {
  const flags = new Set()
  const positional = []
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg.slice(2))
    else positional.push(arg)
  }
  return { command: positional[0] ?? 'help', flags }
}

/** The token right after `backup`, if it is a subcommand rather than a flag. */
function positionalSub(argv) {
  const index = argv.indexOf('backup')
  const next = index >= 0 ? argv[index + 1] : undefined
  return next && !next.startsWith('--') ? next : undefined
}

/** Read a `--key value` pair without turning values into flags. */
function flagValue(argv, key) {
  const prefix = `--${key}`
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === prefix) return argv[index + 1]
    if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1)
  }
  return undefined
}

export function version() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return pkg.version
}

export async function main(argv, io) {
  const { command, flags } = parseArgs(argv)
  const json = flags.has('json')
  const out = (text) => io.stdout(text)
  const err = (text) => io.stderr(text)

  try {
    switch (command) {
      case 'help':
      case '--help':
        out(USAGE)
        return EXIT_OK

      case 'version':
        out(`${version()}\n`)
        return EXIT_OK

      case 'init': {
        const result = writeDefaultConfig({ cwd: io.cwd, force: flags.has('force') })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(`${result.created ? 'created' : 'kept'} ${result.path}\n`)
        return result.created || result.existing ? EXIT_OK : EXIT_FAIL
      }

      case 'doctor': {
        const checks = runDoctor({ cwd: io.cwd, env: io.env, root: ROOT })
        const worst = worstStatus(checks)
        if (json) out(`${JSON.stringify({ checks, summary: summarize(checks) }, null, 2)}\n`)
        else out(`${formatChecks(checks)}\n`)
        return worst
      }

      case 'status': {
        const config = loadConfig({ cwd: io.cwd })
        const capabilities = loadCapabilities({ cwd: io.cwd, root: ROOT })
        const probed = await probeCapabilities(capabilities, { config })
        const worst = worstStatus(probed.map((c) => ({ status: c.status })))
        if (json) {
          out(`${JSON.stringify({ capabilities: probed, summary: summarize(probed) }, null, 2)}\n`)
        } else {
          out(`${formatCapabilityTable(probed)}\n`)
        }
        return worst
      }

      case 'apply': {
        const result = apply({ cwd: io.cwd, dryRun: flags.has('dry-run') })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(`${describeApply(result)}\n`)
        return EXIT_OK
      }

      case 'verify': {
        const result = verify({ cwd: io.cwd })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(`${describeVerify(result)}\n`)
        return result.ok ? EXIT_OK : EXIT_WARN
      }

      case 'rollback': {
        const to = flagValue(argv, 'to')
        const result = rollback({ cwd: io.cwd, to, dryRun: flags.has('dry-run') })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(`${describeRollback(result)}\n`)
        return EXIT_OK
      }

      case 'backup': {
        const sub = positionalSub(argv)
        const config = loadConfig({ cwd: io.cwd })
        if (sub === 'check') {
          const result = check({ cwd: io.cwd, config })
          if (json) out(`${JSON.stringify(result, null, 2)}\n`)
          else out(formatBackup(result, 'check'))
          return result.ok ? EXIT_OK : EXIT_FAIL
        }
        if (sub === 'restore') {
          const result = restore({ cwd: io.cwd, config, into: flagValue(argv, 'into') })
          if (json) out(`${JSON.stringify(result, null, 2)}\n`)
          else out(formatBackup(result, 'restore'))
          return result.ok ? EXIT_OK : EXIT_FAIL
        }
        const result = backup({ cwd: io.cwd, config, dryRun: flags.has('dry-run') })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(formatBackup(result, 'backup'))
        return result.ok ? EXIT_OK : EXIT_FAIL
      }

      case 'notify': {
        const config = loadConfig({ cwd: io.cwd })
        const result = await notify({
          cwd: io.cwd,
          config,
          title: flagValue(argv, 'title') ?? '',
          body: flagValue(argv, 'body') ?? '',
          dryRun: flags.has('dry-run'),
        })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(`${describeNotify(result)}\n`)
        return result.ok ? EXIT_OK : EXIT_FAIL
      }

      case 'expose': {
        const config = loadConfig({ cwd: io.cwd })
        const result = expose({ config, dryRun: flags.has('dry-run'), off: flags.has('off') })
        if (json) out(`${JSON.stringify(result, null, 2)}\n`)
        else out(`${describeExpose(result)}\n`)
        return result.ok ? EXIT_OK : EXIT_FAIL
      }

      case 'plan': {
        const config = loadConfig({ cwd: io.cwd })
        const plan = buildPlan({ config, root: ROOT })
        if (json) out(`${JSON.stringify(plan, null, 2)}\n`)
        else out(`${formatPlan(plan)}\n`)
        return EXIT_OK
      }

      default:
        err(`unknown command: ${command}\n\n${USAGE}`)
        return EXIT_FAIL
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (json) out(`${JSON.stringify({ error: message }, null, 2)}\n`)
    else err(`station: ${message}\n`)
    return EXIT_FAIL
  }
}

function formatBackup(result, kind) {
  if (!result.ok) {
    const lines = [`${kind}: failed at ${result.stage ?? 'unknown'}: ${result.error}`]
    if (result.hint) lines.push(`  fix: ${result.hint}`)
    return lines.join('\n')
  }
  const lines = []
  if (kind === 'backup') {
    if (result.dryRun) {
      lines.push('backup (dry run): nothing written')
      lines.push(`  restic: ${result.restic}`)
      lines.push(`  repo:   ${result.repo}${result.wouldInit ? ' (would be initialised)' : ''}`)
      for (const source of result.wouldBackup ?? []) lines.push(`  source: ${source}`)
    } else {
      lines.push(`backup: ${result.repo}`)
      lines.push(`  restic: ${result.restic}`)
      if (result.output) lines.push(`  ${result.output}`)
    }
  }
  if (kind === 'check') {
    lines.push(`check: ${result.repo} ok`)
    if (result.output) lines.push(`  ${result.output}`)
  }
  if (kind === 'restore') {
    lines.push(`restore: ${result.repo} → ${result.target}`)
    if (result.summary) lines.push(`  ${result.summary}`)
  }
  return lines.join('\n')
}

export function summarize(items) {
  const summary = { ok: 0, warn: 0, critical: 0, unknown: 0 }
  for (const item of items) summary[item.status] = (summary[item.status] ?? 0) + 1
  return summary
}

function worstStatus(items) {
  if (items.some((i) => i.status === 'critical')) return EXIT_FAIL
  if (items.some((i) => i.status === 'warn' || i.status === 'unknown')) return EXIT_WARN
  return EXIT_OK
}

export { configPath }