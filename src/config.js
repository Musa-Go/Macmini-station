/**
 * station.json loading, defaults and validation.
 *
 * The file is deliberately JSON rather than YAML so the toolkit stays
 * dependency-free: a fresh machine only needs Node.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { validateConfig } from './schema.js'

export const CONFIG_FILE = 'station.json'

export function configPath({ cwd }) {
  return join(resolve(cwd), CONFIG_FILE)
}

export function defaultConfig() {
  return {
    schemaVersion: 1,
    machine: {
      displayName: 'Mac mini',
      profile: 'macos-apple-silicon',
    },
    storage: {
      backup: {
        enabled: true,
        target: { type: 'local', path: '~/Backups/Macmini-station' },
        include: ['.station', 'station.json'],
        schedule: '30 3 * * *',
        retention: { daily: 7, weekly: 4, monthly: 6 },
      },
    },
    remoteAccess: { enabled: false, provider: 'tailscale' },
    notifications: { primary: 'none' },
    agent: { enabled: false, workingDirectory: '' },
    capabilities: { enabled: ['local-backup', 'http-endpoint'] },
  }
}

export function writeDefaultConfig({ cwd, force = false }) {
  const path = configPath({ cwd })
  if (existsSync(path) && !force) return { created: false, existing: true, path }
  const config = defaultConfig()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 })
  return { created: true, existing: false, path }
}

export function loadConfig({ cwd }) {
  const path = configPath({ cwd })
  if (!existsSync(path)) {
    // A missing config is not an error: status/plan work against defaults so a
    // fresh machine can inspect itself before writing anything.
    return { ...defaultConfig(), __meta: { path, present: false, problems: [] } }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${reason}`)
  }
  const problems = validateConfig(parsed)
  if (problems.length > 0) {
    const first = problems[0]
    throw new Error(`${CONFIG_FILE} invalid at ${first.path}: ${first.message}`)
  }
  return { ...parsed, __meta: { path, present: true, problems } }
}