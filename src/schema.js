/**
 * Minimal structural validation for station.json.
 *
 * A hand-written validator keeps the runtime dependency-free; the JSON Schema in
 * schema/station.schema.json is the documented contract and is checked against
 * this implementation by the tests.
 */

const BACKUP_TARGET_TYPES = ['local', 'external-disk', 'smb-restic', 's3-restic']
const NOTIFICATION_PROVIDERS = ['none', 'qq', 'bark']
const REMOTE_PROVIDERS = ['tailscale']

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function push(problems, path, message) {
  problems.push({ path, message })
}

function requireString(problems, value, path) {
  if (typeof value !== 'string' || value.trim() === '') {
    push(problems, path, 'must be a non-empty string')
  }
}

function requireBoolean(problems, value, path) {
  if (typeof value !== 'boolean') push(problems, path, 'must be true or false')
}

function requireEnum(problems, value, allowed, path) {
  if (!allowed.includes(value)) push(problems, path, `must be one of ${allowed.join(', ')}`)
}

function requireIntegerRange(problems, value, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    push(problems, path, `must be an integer between ${min} and ${max}`)
  }
}

function checkSchedule(problems, value, path) {
  if (typeof value !== 'string') {
    push(problems, path, 'must be a cron-like string')
    return
  }
  const fields = value.trim().split(/\s+/)
  if (fields.length !== 5) push(problems, path, 'must have five space-separated fields')
}

export function validateConfig(config) {
  const problems = []
  if (!isPlainObject(config)) {
    push(problems, '', 'must be an object')
    return problems
  }

  if (config.schemaVersion !== 1) push(problems, 'schemaVersion', 'must be 1')

  if (!isPlainObject(config.machine)) push(problems, 'machine', 'must be an object')
  else {
    requireString(problems, config.machine.displayName, 'machine.displayName')
    requireString(problems, config.machine.profile, 'machine.profile')
  }

  const storage = config.storage
  if (!isPlainObject(storage)) push(problems, 'storage', 'must be an object')
  else {
    const backup = storage.backup
    if (!isPlainObject(backup)) push(problems, 'storage.backup', 'must be an object')
    else {
      requireBoolean(problems, backup.enabled, 'storage.backup.enabled')
      checkSchedule(problems, backup.schedule, 'storage.backup.schedule')
      const target = backup.target
      if (!isPlainObject(target)) push(problems, 'storage.backup.target', 'must be an object')
      else {
        requireEnum(problems, target.type, BACKUP_TARGET_TYPES, 'storage.backup.target.type')
        requireString(problems, target.path, 'storage.backup.target.path')
        if (target.type === 'smb-restic') {
          requireString(problems, target.host, 'storage.backup.target.host')
          requireString(problems, target.share, 'storage.backup.target.share')
        }
      }
      if (backup.include !== undefined) {
        if (!Array.isArray(backup.include)) push(problems, 'storage.backup.include', 'must be an array of paths')
        else {
          for (const entry of backup.include) {
            if (typeof entry !== 'string' || entry.trim() === '') {
              push(problems, 'storage.backup.include', 'entries must be non-empty strings')
            }
          }
        }
      }
      const retention = backup.retention
      if (!isPlainObject(retention)) push(problems, 'storage.backup.retention', 'must be an object')
      else {
        requireIntegerRange(problems, retention.daily, 'storage.backup.retention.daily', 1, 365)
        requireIntegerRange(problems, retention.weekly, 'storage.backup.retention.weekly', 0, 52)
        requireIntegerRange(problems, retention.monthly, 'storage.backup.retention.monthly', 0, 24)
      }
    }
  }

  const remote = config.remoteAccess
  if (!isPlainObject(remote)) push(problems, 'remoteAccess', 'must be an object')
  else {
    requireBoolean(problems, remote.enabled, 'remoteAccess.enabled')
    requireEnum(problems, remote.provider, REMOTE_PROVIDERS, 'remoteAccess.provider')
  }

  const notifications = config.notifications
  if (!isPlainObject(notifications)) push(problems, 'notifications', 'must be an object')
  else requireEnum(problems, notifications.primary, NOTIFICATION_PROVIDERS, 'notifications.primary')

  const agent = config.agent
  if (!isPlainObject(agent)) push(problems, 'agent', 'must be an object')
  else {
    requireBoolean(problems, agent.enabled, 'agent.enabled')
    if (typeof agent.workingDirectory !== 'string') {
      push(problems, 'agent.workingDirectory', 'must be a string')
    }
    if (agent.enabled && String(agent.workingDirectory ?? '').trim() === '') {
      push(problems, 'agent.workingDirectory', 'is required when agent.enabled is true')
    }
  }

  const capabilities = config.capabilities
  if (!isPlainObject(capabilities)) push(problems, 'capabilities', 'must be an object')
  else if (!Array.isArray(capabilities.enabled)) {
    push(problems, 'capabilities.enabled', 'must be an array of capability ids')
  } else {
    const seen = new Set()
    for (const id of capabilities.enabled) {
      if (typeof id !== 'string' || id.trim() === '') {
        push(problems, 'capabilities.enabled', 'entries must be non-empty strings')
        continue
      }
      if (seen.has(id)) push(problems, 'capabilities.enabled', `duplicate capability id: ${id}`)
      seen.add(id)
    }
  }

  return problems
}