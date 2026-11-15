/**
 * Capability registry.
 *
 * A capability is a JSON manifest shipped with the tool (or dropped into the
 * user's own directory) that declares what it needs, how to probe it, and what
 * it protects. The core never guesses: unknown probe kinds report `unknown`
 * instead of pretending to be healthy.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { httpProbe, fileFreshnessProbe, mountProbe, pathExistsProbe } from './probes.js'

const SUPPORTED_KINDS = new Set(['http', 'file-freshness', 'mount', 'path'])

export function loadCapabilities({ cwd, root }) {
  const dirs = [join(root, 'capabilities'), join(cwd, 'capabilities')]
  const manifests = new Map()

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue
      const path = join(dir, entry)
      let manifest
      try {
        manifest = JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        manifests.set(`${path}#invalid`, { id: `${path}#invalid`, invalid: reason, path })
        continue
      }
      const problems = validateManifest(manifest)
      const id = typeof manifest?.id === 'string' ? manifest.id : entry.replace(/\.json$/, '')
      manifests.set(id, { ...manifest, id, path, problems })
    }
  }

  return [...manifests.values()]
}

export function validateManifest(manifest) {
  const problems = []
  if (typeof manifest !== 'object' || manifest === null) return ['manifest must be an object']
  if (typeof manifest.id !== 'string' || manifest.id.trim() === '') problems.push('id is required')
  if (typeof manifest.title !== 'string' || manifest.title.trim() === '') problems.push('title is required')
  if (typeof manifest.kind !== 'string' || !SUPPORTED_KINDS.has(manifest.kind)) {
    problems.push(`kind must be one of ${[...SUPPORTED_KINDS].join(', ')}`)
  }
  if (typeof manifest.summary !== 'string') problems.push('summary is required')
  return problems
}

export async function probeCapabilities(capabilities, { config }) {
  const results = []
  for (const capability of capabilities) {
    results.push(await probeOne(capability, config))
  }
  return results
}

async function probeOne(capability, config) {
  const base = {
    id: capability.id ?? 'unknown',
    title: capability.title ?? capability.id ?? 'unknown',
    kind: capability.kind ?? 'unknown',
    optional: capability.optional === true,
  }

  if (capability.invalid || (capability.problems && capability.problems.length > 0)) {
    const detail = capability.invalid ?? capability.problems.join('; ')
    return { ...base, status: 'critical', detail: `invalid manifest: ${detail}` }
  }

  const enabled = config?.capabilities?.enabled ?? []
  if (enabled.length > 0 && !enabled.includes(capability.id)) {
    return { ...base, status: 'unknown', detail: 'not enabled in station.json' }
  }

  const probe = capability.probe ?? {}
  try {
    switch (capability.kind) {
      case 'http': {
        const result = await httpProbe({
          url: probe.url,
          expect: probe.expect ?? [200],
          timeoutMs: probe.timeoutMs,
        })
        return toStatus(base, result, { optional: base.optional })
      }
      case 'file-freshness': {
        const result = fileFreshnessProbe({
          globDir: probe.directory,
          maxAgeHours: probe.maxAgeHours,
        })
        return toStatus(base, result, { optional: base.optional })
      }
      case 'mount': {
        const result = mountProbe({ path: probe.path })
        return toStatus(base, result, { optional: base.optional })
      }
      case 'path': {
        const result = pathExistsProbe({ path: probe.path })
        return toStatus(base, result, { optional: base.optional })
      }
      default:
        return { ...base, status: 'unknown', detail: `probe kind ${capability.kind} not implemented` }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...base, status: 'critical', detail: `probe crashed: ${reason}` }
  }
}

function toStatus(base, result, { optional }) {
  if (result.ok === null) return { ...base, status: 'unknown', detail: result.detail }
  if (result.ok) return { ...base, status: 'ok', detail: result.detail }
  return {
    ...base,
    status: optional ? 'warn' : 'critical',
    detail: result.detail,
  }
}

export function formatCapabilityTable(capabilities) {
  if (capabilities.length === 0) return 'no capabilities registered'
  const icon = { ok: '[ok]  ', warn: '[warn]', critical: '[fail]', unknown: '[??]  ' }
  const lines = capabilities.map(
    (c) => `${icon[c.status] ?? '[??]  '} ${String(c.title).padEnd(22)} ${String(c.kind).padEnd(16)} ${c.detail}`,
  )
  const summary = { ok: 0, warn: 0, critical: 0, unknown: 0 }
  for (const c of capabilities) summary[c.status] = (summary[c.status] ?? 0) + 1
  lines.push('', `ok ${summary.ok} · warn ${summary.warn} · critical ${summary.critical} · unknown ${summary.unknown}`)
  return lines.join('\n')
}