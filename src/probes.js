/**
 * Probes used by `station doctor` and `station status`.
 *
 * Every probe is a pure-ish function with injectable dependencies so tests can
 * run without touching the real machine.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function run(command, args, { timeout = 5000 } = {}) {
  try {
    const stdout = execFileSync(command, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout: stdout.trim(), code: 0 }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? '').trim(),
      code: typeof error?.status === 'number' ? error.status : null,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

export function expandHome(inputPath) {
  if (typeof inputPath !== 'string' || !inputPath.startsWith('~')) return inputPath
  return join(homedir(), inputPath.slice(1))
}

export async function httpProbe({ url, expect = [200], timeoutMs = 3000, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') return { ok: null, detail: 'fetch unavailable' }
  const payload = JSON.stringify({ url })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'macmini-station-probe' },
    })
    const ok = expect.includes(response.status)
    return { ok, detail: `HTTP ${response.status}`, extra: payload }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: `request failed: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}

export function fileFreshnessProbe({ globDir, maxAgeHours = 26, now = Date.now() }) {
  const dir = expandHome(globDir)
  if (!existsSync(dir)) return { ok: false, detail: `missing directory: ${dir}` }
  let newest = null
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const stat = statSync(join(dir, entry))
    if (!stat.isFile()) continue
    if (newest === null || stat.mtimeMs > newest.mtimeMs) newest = { name: entry, mtimeMs: stat.mtimeMs }
  }
  if (newest === null) return { ok: false, detail: `no files in ${dir}` }
  const ageHours = (now - newest.mtimeMs) / 3_600_000
  const ok = ageHours <= maxAgeHours
  return {
    ok,
    detail: `${newest.name}, ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h)`,
  }
}

export function mountProbe({ path }) {
  const target = expandHome(path)
  const result = run('/sbin/mount', [])
  if (!result.ok) return { ok: null, detail: `cannot read mount table: ${result.message ?? 'unknown error'}` }
  const mounted = result.stdout.split('\n').some((line) => line.includes(` on ${target} `))
  return { ok: mounted, detail: mounted ? `mounted at ${target}` : `not mounted: ${target}` }
}

export function commandProbe({ command, args = [] }) {
  const result = run(command, args)
  return {
    ok: result.ok,
    detail: result.ok ? `${command} ok` : `${command} failed (code ${result.code ?? 'n/a'})`,
  }
}

export function pathExistsProbe({ path }) {
  const target = resolve(expandHome(path))
  return { ok: existsSync(target), detail: existsSync(target) ? `found ${target}` : `missing ${target}` }
}