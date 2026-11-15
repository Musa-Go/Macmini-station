/**
 * Backup execution via restic.
 *
 * Deliberate constraint: this module never ships or downloads a restic binary.
 * It locates one the user installed, verifies it can run, and explains how to
 * install it when missing. That keeps the repository free of a supply-chain
 * surface it would otherwise have to sign, verify and update forever.
 */

import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs'
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

/** Target types this build can actually execute. Others must fail closed. */
export const EXECUTABLE_TARGET_TYPES = ['local', 'external-disk', 'smb-restic']

export function resolveTarget(config) {
  const backup = config.storage?.backup
  if (!backup?.enabled) return { ok: false, error: 'backup disabled in station.json (storage.backup.enabled=false)' }
  const target = backup.target ?? {}
  const type = String(target.type ?? '')
  if (!EXECUTABLE_TARGET_TYPES.includes(type)) {
    return {
      ok: false,
      error: `backup target type "${type}" is not implemented; refusing to write a local repository instead`,
      hint: 'use a local or external-disk path, or mount the remote and use smb-restic',
    }
  }
  const raw = String(target.path ?? '').trim()
  if (raw === '') return { ok: false, error: 'storage.backup.target.path is empty' }
  const path = resolve(expandHome(raw))
  if (path === '/') return { ok: false, error: 'storage.backup.target.path must not be the filesystem root' }
  return { ok: true, type, path }
}

/**
 * The password file is a secret: it must be a regular file owned by us and not
 * readable by other users. A permissive password file silently undermines the
 * whole repository, so it is a hard error rather than a hint.
 */
export function checkPasswordFile(path, { stat = statSync, lstat = lstatSync, uid = process.getuid?.() } = {}) {
  let info
  try {
    info = lstat(path)
  } catch (error) {
    return { ok: false, error: `cannot stat RESTIC_PASSWORD_FILE: ${String(error?.message ?? error)}` }
  }
  if (info.isSymbolicLink()) {
    const target = stat(path)
    if (!target.isFile()) return { ok: false, error: 'RESTIC_PASSWORD_FILE must point at a regular file' }
  } else if (!info.isFile()) {
    return { ok: false, error: 'RESTIC_PASSWORD_FILE must be a regular file' }
  }
  if (typeof uid === 'number' && info.uid !== uid) {
    return { ok: false, error: 'RESTIC_PASSWORD_FILE is owned by another user' }
  }
  if ((info.mode & 0o077) !== 0) {
    return {
      ok: false,
      error: `RESTIC_PASSWORD_FILE is readable by other users (mode ${(info.mode & 0o777).toString(8)}); run: chmod 600 ${path}`,
    }
  }
  return { ok: true }
}

/** Paths to snapshot: config.include, resolved against the station directory. */
export function resolveSources({ config, cwd, onlyExisting = true }) {
  const include = config.storage?.backup?.include ?? ['.station', 'station.json']
  const resolved = include.map((entry) => {
    const raw = String(entry)
    return raw.startsWith('~') || raw.startsWith('/') ? resolve(expandHome(raw)) : resolve(cwd, raw)
  })
  return onlyExisting ? resolved.filter((p) => existsSync(p)) : resolved
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
  const permissions = checkPasswordFile(passwordFile)
  if (!permissions.ok) return { ok: false, stage: 'password', error: permissions.error }

  const repoExists = existsSync(repo.repo)
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      restic: restic.path,
      repo: repo.repo,
      wouldInit: !repoExists,
      wouldBackup: resolveSources({ config, cwd, onlyExisting: false }),
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

  const sources = resolveSources({ config, cwd })
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
  const permissions = checkPasswordFile(env.RESTIC_PASSWORD_FILE)
  if (!permissions.ok) return { ok: false, stage: 'password', error: permissions.error }
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
  const permissions = checkPasswordFile(env.RESTIC_PASSWORD_FILE)
  if (!permissions.ok) return { ok: false, stage: 'password', error: permissions.error }

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
