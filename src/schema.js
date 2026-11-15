/**
 * Minimal structural validation for station.json.
 *
 * A hand-written validator keeps the runtime dependency-free; the JSON Schema in
 * schema/station.schema.json is the documented contract and is checked against
 * this implementation by the tests.
 */

const BACKUP_TARGET_TYPES = ['local', 'external-disk', 'smb-restic', 's3-restic']
const NOTIFICATION_PROVIDERS = ['none', 'qq', 'bark']
// Credential references must look like references, never like raw secrets.
const SECRET_LIKE = /^(sk-|oc_|ghp_|gho_|xox[baprs]-)|^[A-Za-z0-9_-]{32,}$/
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
    if (remote.enabled === true && remote.ports === undefined) {
      push(problems, 'remoteAccess.ports', 'is required (and must not be empty) when remoteAccess.enabled is true')
    }
    if (remote.ports !== undefined) {
      if (!Array.isArray(remote.ports)) push(problems, 'remoteAccess.ports', 'must be an array of port numbers')
      else {
        for (const port of remote.ports) {
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            push(problems, 'remoteAccess.ports', 'each port must be an integer between 1 and 65535')
          }
        }
        if (remote.enabled && remote.ports.length === 0) {
          push(problems, 'remoteAccess.ports', 'must not be empty when remoteAccess.enabled is true')
        }
      }
    }
  }

  const notifications = config.notifications
  if (!isPlainObject(notifications)) push(problems, 'notifications', 'must be an object')
  else {
    requireEnum(problems, notifications.primary, NOTIFICATION_PROVIDERS, 'notifications.primary')

    if (notifications.fallback !== undefined && notifications.fallback !== null) {
      requireEnum(problems, notifications.fallback, NOTIFICATION_PROVIDERS, 'notifications.fallback')
      if (notifications.fallback === notifications.primary) {
        push(problems, 'notifications.fallback', 'must differ from primary')
      }
    }

    for (const name of ['qq', 'bark']) {
      const connector = notifications[name]
      if (connector === undefined) continue
      if (!isPlainObject(connector)) {
        push(problems, `notifications.${name}`, 'must be an object')
        continue
      }
      if (connector.secretRef !== undefined) {
        if (typeof connector.secretRef !== 'string' || connector.secretRef.trim() === '') {
          push(problems, `notifications.${name}.secretRef`, 'must be a non-empty keychain reference')
        } else if (SECRET_LIKE.test(connector.secretRef.trim())) {
          push(problems, `notifications.${name}.secretRef`, 'looks like a raw secret; store it in the keychain and reference its name')
        }
      }
    }

    if (notifications.primary === 'qq') {
      const qq = notifications.qq
      if (!isPlainObject(qq)) push(problems, 'notifications.qq', 'required when primary is qq')
      else {
        requireString(problems, qq.appId, 'notifications.qq.appId')
        requireString(problems, qq.secretRef, 'notifications.qq.secretRef')
        if (!Array.isArray(qq.allowFrom) || qq.allowFrom.length === 0) {
          push(problems, 'notifications.qq.allowFrom', 'must list at least one openid (otherwise anyone could send commands)')
        } else {
          for (const entry of qq.allowFrom) {
            if (typeof entry !== 'string' || entry.trim() === '') {
              push(problems, 'notifications.qq.allowFrom', 'entries must be non-empty openids')
            }
          }
        }
        if (qq.to !== undefined) requireString(problems, qq.to, 'notifications.qq.to')
      }
    }
    if (notifications.primary === 'bark') {
      const bark = notifications.bark
      if (!isPlainObject(bark)) push(problems, 'notifications.bark', 'required when primary is bark')
      else requireString(problems, bark.secretRef, 'notifications.bark.secretRef')
    }
  }

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

  const agentTaskCfg = config.agent
  if (isPlainObject(agentTaskCfg) && agentTaskCfg.tasks !== undefined) {
    if (!isPlainObject(agentTaskCfg.tasks)) push(problems, 'agent.tasks', 'must be an object of named commands')
    else {
      for (const [name, argv] of Object.entries(agentTaskCfg.tasks)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
          push(problems, `agent.tasks.${name}`, 'task names must start with a letter and use letters, digits, dash or underscore')
          continue
        }
        if (!Array.isArray(argv) || argv.length === 0) {
          push(problems, `agent.tasks.${name}`, 'must be a non-empty argv array, e.g. ["npm","test"]')
          continue
        }
        for (const part of argv) {
          if (typeof part !== 'string' || part === '') {
            push(problems, `agent.tasks.${name}`, 'every argv entry must be a non-empty string')
            break
          }
        }
      }
    }
  }
  if (isPlainObject(agentTaskCfg) && agentTaskCfg.command !== undefined) {
    const cmd = agentTaskCfg.command
    if (!Array.isArray(cmd) || cmd.length === 0) {
      push(problems, 'agent.command', 'must be a non-empty argv array (use {prompt} and/or {worktree} placeholders)')
    } else {
      for (const part of cmd) {
        if (typeof part !== 'string' || part === '') {
          push(problems, 'agent.command', 'every argv entry must be a non-empty string')
          break
        }
      }
    }
  }
  if (isPlainObject(agentTaskCfg) && agentTaskCfg.gate !== undefined) {
    const gate = agentTaskCfg.gate
    if (!isPlainObject(gate)) push(problems, 'agent.gate', 'must be an object like {"task": "test", "required": true}')
    else {
      if (gate.task !== undefined) requireString(problems, gate.task, 'agent.gate.task')
      if (gate.required !== undefined) requireBoolean(problems, gate.required, 'agent.gate.required')
      const tasks = isPlainObject(agentTaskCfg.tasks) ? agentTaskCfg.tasks : {}
      if (typeof gate.task === 'string' && gate.task.trim() !== '' && !Object.hasOwn(tasks, gate.task)) {
        push(problems, 'agent.gate.task', 'must name a task defined in agent.tasks')
      }
    }
  }
  if (isPlainObject(agentTaskCfg) && agentTaskCfg.taskTimeoutSeconds !== undefined) {
    if (!Number.isInteger(agentTaskCfg.taskTimeoutSeconds) || agentTaskCfg.taskTimeoutSeconds < 1 || agentTaskCfg.taskTimeoutSeconds > 3600) {
      push(problems, 'agent.taskTimeoutSeconds', 'must be an integer between 1 and 3600')
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