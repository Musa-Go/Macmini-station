/**
 * Backup execution via restic.
 *
 * Deliberate constraint: this module never ships or downloads a restic binary.
 * It locates one the user installed, verifies it can run, and explains how to
 * install it when missing. That keeps the repository free of a supply-chain
 * surface it would otherwise have to sign, verify and update forever.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { expandHome, run } from './probes.js'
import { stateDir } from './state.js'

const CANDIDATES = [
  '/opt/homebrew/bin/restic',
  '/usr/local/bin/restic',
  '/usr/bin/restic',
  'restic',
]

export const INSTALL_HINT =
  'install restic and re-run: `brew install restic` (or download a signed release from https://github.com/restic/restic/releases)'

export function findRestic({ env = process.env, probe = run } = {}) {
  const explicit = env.RESTIC_BIN
  if (explicit) {
    if (!existsSync(explicit)) {
      return { ok: false, path: explicit, error: `RESTIC_BIN points to a missing file: ${explicit}`, hint: INSTALL_HINT }
    }
    const version = probe(explicit, ['version'])
    if (!version.ok) {
      return { ok: false, path: explicit, error: `RESTIC_BIN is not runnable: ${version.message ?? 'unknown error'}` }
    }
    return { ok: true, path: explicit, version: version.stdout.split('\n')[0] }
  }

  for (const candidate of CANDIDATES) {
    if (candidate !== 'restic' && !existsSync(candidate)) continue
    const version = probe(candidate, ['version'])
    if (version.ok) return { ok: true, path: candidate, version: version.stdout.split('\n')[0] }
  }

  return { ok: false, error: 'restic not found', hint: INSTALL_HINT }
}

export function resolveTarget(config) {
  const backup = config.storage?.backup
  if (!backup?.enabled) return { ok: false, error: 'backup disabled in station.json (storage.backup.enabled=false)' }
  const target = backup.target ?? {}
  const raw = String(target.path ?? '').trim()
  if (raw === '') return { ok: false, error: 'storage.backup.target.path is empty' }
  const path = resolve(expandHome(raw))
  if (path === '/') return { ok: false, error: 'storage.backup.target.path must not be the filesystem root' }
  return { ok: true, type: target.type, path }
}

export function repositoryPath({ config, cwd }) {
  const target = resolveTarget(config)
  if (!target.ok) return target
  // Keep the restic repository inside the target so `verify`/`rollback` keep
  // owning the same paths and the journal stays truthful.
  return { ok: true, repo: join(target.path, 'restic'), target }
}

/**
 * Run `restic backup` with an explicit password source.
 *
 * The password is read from a file the user owns (RESTIC_PASSWORD_FILE), never
 * from argv and never from this process's environment.
 */
export function backup({ cwd, config, env = process.env, dryRun = false, resticBin, exec = execFileSync }) {
  const restic = resticBin ?? findRestic({ env })
  if (!restic.ok) return { ok: false, stage: 'restic', ...restic }

  const repo = repositoryPath({ config, cwd })
  if (!repo.ok) return { ok: false, stage: 'target', ...repo }

  const passwordFile = env.RESTIC_PASSWORD_FILE
  if (!passwordFile) {
    return {
      ok: false,
      stage: 'password',
      error: 'RESTIC_PASSWORD_FILE is not set',
      hint: 'create a password file (chmod 600) and export RESTIC_PASSWORD_FILE=/path/to/it',
    }
  }
  if (!existsSync(passwordFile)) {
    return { ok: false, stage: 'password', error: `RESTIC_PASSWORD_FILE does not exist: ${passwordFile}` }
  }

  const repoExists = existsSync(repo.repo)
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      restic: restic.path,
      repo: repo.repo,
      wouldInit: !repoExists,
      wouldBackup: [stateDir(cwd), configPathFor(cwd)],
    }
  }

  if (!repoExists) {
    mkdirSync(repo.repo, { recursive: true })
    try {
      exec(restic.path, ['--repo', repo.repo, 'init'], { env: { ...env, RESTIC_PASSWORD_FILE: passwordFile } })
    } catch (error) {
      return { ok: false, stage: 'init', error: messageOf(error) }
    }
  }

  const sources = [stateDir(cwd), configPathFor(cwd)].filter((p) => existsSync(p))
  if (sources.length === 0) return { ok: false, stage: 'sources', error: 'nothing to back up yet; run `station apply` first' }

  try {
    const stdout = exec(restic.path, ['--repo', repo.repo, 'backup', ...sources, '--tag', 'station'], {
      env: { ...env, RESTIC_PASSWORD_FILE: passwordFile },
      encoding: 'utf8',
    })
    return {
      ok: true,
      repo: repo.repo,
      restic: restic.path,
      sources,
      output: String(stdout).trim().split('\n').pop(),
    }
  } catch (error) {
    return { ok: false, stage: 'backup', error: messageOf(error) }
  }
}

/** `restic check`: proves the repository is structurally readable. */
export function check({ cwd, config, env = process.env, resticBin, exec = execFileSync }) {
  const restic = resticBin ?? findRestic({ env })
  if (!restic.ok) return { ok: false, stage: 'restic', ...restic }
  const repo = repositoryPath({ config, cwd })
  if (!repo.ok) return { ok: false, stage: 'target', ...repo }
  if (!existsSync(repo.repo)) return { ok: false, stage: 'repo', error: `no repository at ${repo.repo}; run \`station backup\` first` }
  if (!env.RESTIC_PASSWORD_FILE) return { ok: false, stage: 'password', error: 'RESTIC_PASSWORD_FILE is not set' }
  try {
    const stdout = exec(restic.path, ['--repo', repo.repo, 'check'], {
      env: { ...env, RESTIC_PASSWORD_FILE: env.RESTIC_PASSWORD_FILE },
      encoding: 'utf8',
    })
    return { ok: true, repo: repo.repo, output: String(stdout).trim().split('\n').slice(-2).join(' ') }
  } catch (error) {
    return { ok: false, stage: 'check', error: messageOf(error) }
  }
}

/** Restore the latest snapshot into a directory for a real recovery drill. */
export function restore({ cwd, config, env = process.env, into, resticBin, exec = execFileSync }) {
  const restic = resticBin ?? findRestic({ env })
  if (!restic.ok) return { ok: false, stage: 'restic', ...restic }
  const repo = repositoryPath({ config, cwd })
  if (!repo.ok) return { ok: false, stage: 'target', ...repo }
  if (!into) return { ok: false, stage: 'arguments', error: 'restore needs --into <directory>' }
  if (!existsSync(repo.repo)) return { ok: false, stage: 'repo', error: `no repository at ${repo.repo}` }
  if (!env.RESTIC_PASSWORD_FILE) return { ok: false, stage: 'password', error: 'RESTIC_PASSWORD_FILE is not set' }

  const target = resolve(expandHome(into))
  mkdirSync(target, { recursive: true })
  try {
    const stdout = exec(restic.path, ['--repo', repo.repo, 'restore', 'latest', '--target', target], {
      env: { ...env, RESTIC_PASSWORD_FILE: env.RESTIC_PASSWORD_FILE },
      encoding: 'utf8',
    })
    const summary = String(stdout).trim().split('\n').filter(Boolean).slice(-1)[0] ?? ''
    return { ok: true, repo: repo.repo, target, summary }
  } catch (error) {
    return { ok: false, stage: 'restore', error: messageOf(error) }
  }
}

function messageOf(error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : ''
  return (stderr || (error instanceof Error ? error.message : String(error))).trim().slice(0, 300)
}

function configPathFor(cwd) {
  return join(cwd, 'station.json')
}
