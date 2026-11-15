# Macmini-station

把一台 Mac mini 上验证过的工作站能力，整理成**可以在别的机器上安装、检查、备份和逐步扩展**的本地优先工具。

> 状态：M0 骨架（0.1.0）。`doctor` / `status` / `plan` / `init` 可用；安装、升级、回滚、备份执行、远程访问与 Agent 执行仍在路线图上。

## 设计原则

1. **零运行时依赖**：只用 Node 内置模块，克隆下来就能跑，不需要 `npm install`。
2. **本地优先**：默认只监听 loopback，不要求公网、域名或 VPN。
3. **NAS 可选**：备份目标可以是本机目录、外接磁盘或 NAS；没有 NAS 时核心功能完整可用，只把"未配置异地备份"如实标出来。
4. **未知就是未知**：探测不到的能力报 `unknown`，不用默认值假装健康。
5. **规划与执行分离**：`plan` 只描述将要做什么，不改变系统；真正写入留给后续里程碑的显式命令。

## 快速开始

```bash
git clone https://github.com/Musa-Go/Macmini-station.git
cd Macmini-station

node bin/station.js doctor        # 检查这台机器
node bin/station.js init          # 写出 station.json
node bin/station.js plan          # 看当前配置会做什么（只读）
node bin/station.js status        # 探测已注册能力
```

所有命令都支持 `--json`，输出可直接被面板或脚本消费。

退出码：`0` 正常，`1` 有告警，`2` 有严重问题或参数错误。

## 命令

| 命令 | 作用 | 是否改系统 |
|---|---|---|
| `station doctor` | 检查 Node、平台、配置、备份目标、远程访问、通知、git、容器运行时、profile | 否 |
| `station status` | 按能力清单逐个探测，输出 ok/warn/critical/unknown | 否 |
| `station plan` | 列出当前 profile 将配置哪些能力、各自的前置条件 | 否 |
| `station init` | 生成默认 `station.json`（已存在则不覆盖，除非 `--force`） | 只写一个配置文件 |
| `station version` / `station help` | 版本与帮助 | 否 |

## 配置

`station.json` 放在运行目录，结构见 [`schema/station.schema.json`](schema/station.schema.json)。默认值：

```json
{
  "schemaVersion": 1,
  "machine": { "displayName": "Mac mini", "profile": "macos-apple-silicon" },
  "storage": {
    "backup": {
      "enabled": true,
      "target": { "type": "local", "path": "~/Backups/Macmini-station" },
      "schedule": "30 3 * * *",
      "retention": { "daily": 7, "weekly": 4, "monthly": 6 }
    }
  },
  "remoteAccess": { "enabled": false, "provider": "tailscale" },
  "notifications": { "primary": "none" },
  "agent": { "enabled": false, "workingDirectory": "" },
  "capabilities": { "enabled": ["local-backup", "http-endpoint"] }
}
```

- 备份目标 `type` 支持 `local`、`external-disk`、`smb-restic`、`s3-restic`（后两者尚未实现执行）。
- `remoteAccess.enabled=false` 时完全本地，不发布任何端口。
- `agent.enabled` 默认关闭；在隔离 worktree、预算与测试门槛实现之前，不应打开。

## 能力清单

`capabilities/*.json` 是能力声明：`id`、`title`、`kind`、`probe`、`data`、`permissions`。

支持的 `kind`：`path`、`file-freshness`、`mount`、`http`。未知 kind 报 `unknown`，不会执行任意命令。

- 仓库自带两个示例：`local-backup`、`http-endpoint`（故意指向关闭端口，避免假成功）。
- 用户可在运行目录建 `capabilities/` 覆盖同名能力。

## 开发

```bash
npm test                     # node --test，零依赖
node bin/station.js doctor   # 手动冒烟
```

CI 在 Node 20/22/24 上运行测试，并强制检查"没有运行时依赖"。

## 路线图

| 里程碑 | 内容 |
|---|---|
| M0（当前） | CLI 骨架、配置 schema、能力清单、doctor/status/plan |
| M1 | `apply`：按 profile 创建目录、写服务定义、可回滚；能力 manifest 渲染 |
| M2 | 备份执行：restic 封装、local/USB/NAS 适配器、`check`、恢复演练 |
| M3 | 远程访问与通知连接器（Tailscale、QQ、Bark），全部 opt-in |
| M4 | 隔离的 Agent 任务执行、repo allowlist、预算与时限 |
| M5 | GitHub CI/PR 集成，默认只开 Draft PR，人工合并后才发布 |

## 安全边界

- 工具不会替你 `git init`、不自动推代码、不读取密钥文件。
- 能力探测只做 HTTP/路径/挂载/文件新鲜度检查，不执行 manifest 里声明的任意命令。
- 配置里不存明文凭据；后续连接器使用系统钥匙串引用。

## 许可

尚未选定许可证（UNLICENSED）。在明确许可证之前，请勿外部分发。