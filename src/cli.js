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