# Macmini-station

[![ci](https://github.com/Musa-Go/Macmini-station/actions/workflows/ci.yml/badge.svg)](https://github.com/Musa-Go/Macmini-station/actions/workflows/ci.yml)

把一台 Mac mini 上验证过的**工作站能力**，整理成能在别的机器上安装、检查、备份、逐步扩展的本地优先工具。

> **状态**：`0.1.0` · M0 已合并。`doctor` / `status` / `plan` / `init` 可用并受 CI 保护（Node 20 / 22 / 24）。
> 安装执行（`apply`）、备份执行、连接器与 Agent 执行仍在路线图上，见 [路线图](#路线图)。

---

## 1. 它解决什么问题

自建一台常年在线的 Mac mini 当工作站，通常会散落成这样一堆东西：launchd 服务、OrbStack 容器、Tailscale 入口、NAS 备份、脚本、定时任务、模型 key。

换一台机器时，这些知识只存在你脑子里和零散脚本里，于是：

- 不知道该装什么、装到哪、依赖什么权限；
- 不知道某个服务挂了没有，只能逐个 `curl`；
- 备份"看起来有"，但从没验证过能不能恢复；
- 有 NAS 的人和无 NAS 的人需要两套完全不同的路径。

`Macmini-station` 把这些变成**可检查、可计划、可回滚**的东西：一份配置文件、一份能力清单、一组只读检查命令。**NAS、Tailscale、QQ、AI 供应商全部可选**；一个什么都还没有的干净 Mac 也能安装并跑通核心检查。

---

## 2. 设计原则

| 原则 | 含义 | 落地方式 |
|---|---|---|
| **零运行时依赖** | 只有 Node 内置模块，克隆即可运行 | CI 里有一条硬性守卫：`dependencies` 非空即失败 |
| **本地优先** | 默认只监听 loopback，不要求公网/域名/VPN | `remoteAccess.enabled` 默认 `false` |
| **NAS 可选** | 备份目标可以是本机目录、外接盘、NAS 或对象存储 | 缺 NAS 时降级为 `warn`，不阻塞任何功能 |
| **未知即未知** | 探测不到就报 `unknown`，不用默认值假装健康 | 未知的 `kind` 直接 `unknown`，不执行任意命令 |
| **规划与执行分离** | `plan` 只描述将要发生什么 | `plan` 全程只读；`apply` 才写磁盘 |
| **不自动启动服务** | 写入配置与注册常驻服务是两件事 | `apply` 不生成 launchd、不启动进程 |

---

## 3. 快速开始

```bash
git clone https://github.com/Musa-Go/Macmini-station.git
cd Macmini-station

node bin/station.js doctor        # 这台机器能不能跑，缺什么
node bin/station.js init          # 写出 station.json（已存在则不覆盖）
node bin/station.js plan          # 当前配置会做什么，只读
node bin/station.js status        # 探测已注册能力
```

要求：**Node.js ≥ 20.11**。Apple Silicon macOS 是一等目标；Intel Mac 与其它平台会显式报告为 best-effort。

---

## 4. 命令

| 命令 | 作用 | 是否改动系统 | 退出码 |
|---|---|---|---|
| `station doctor` | 检查 Node、平台、配置文件、备份目标、远程访问、通知、Agent、git、容器运行时、profile | 否 | 0 / 1 / 2 |
| `station status` | 按能力清单逐项探测，输出 `ok`/`warn`/`critical`/`unknown` | 否 | 0 / 1 / 2 |
| `station plan` | 列出当前 profile 将要配置哪些能力，以及各自前置条件 | 否 | 0 |
| `station init` | 生成默认 `station.json`；已存在时保留，除非 `--force` | 只写一个配置文件 | 0 / 2 |
| `station version` | 打印版本 | 否 | 0 |
| `station help` | 打印用法 | 否 | 0 |

所有命令都支持 `--json`，输出是稳定的机器可读结构，可直接喂给面板、告警或 QQ 机器人。

**退出码约定**：`0` 全部正常 · `1` 存在告警（工具仍可用）· `2` 存在严重问题或参数错误。CI 里的冒烟步骤就按这个契约断言，而不是要求 `0`。

### 示例输出

```console
$ node bin/station.js doctor
[ok]   Node.js              v26.10.0 (need >= 20)
[ok]   Platform             macOS arm64
[warn] station.json         not found, defaults in use
[warn] Backup target        /Users/musa/Backups/Macmini-station does not exist yet
[ok]   Remote access        disabled (local-only)
[ok]   Notifications        disabled
[ok]   Agent jobs           disabled (no automated code execution)
[ok]   git                  git version 2.49.0
[ok]   Container runtime    Docker version 29.8.2
[ok]   Profile              macos-apple-silicon (2 capabilities)

Fixes:
  - station.json: run `station init` to write a config you can edit
  - Backup target: create the directory (planned: `station apply` creates it) or point the path elsewhere

ok 8 · warn 2 · critical 0 · unknown 0
```

---

## 5. 配置：`station.json`

放在运行目录。完整契约见 [`schema/station.schema.json`](schema/station.schema.json)；默认值由 `station init` 生成。

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

| 字段 | 取值 | 说明 |
|---|---|---|
| `machine.profile` | `profiles/` 下的文件名 | 决定启用哪些能力 |
| `storage.backup.target.type` | `local` · `external-disk` · `smb-restic` · `s3-restic` | 后两者尚未实现执行，只做校验与提示 |
| `storage.backup.target.path` | 路径，支持 `~/` | 目标不存在时报 `warn`，不自动创建 |
| `storage.backup.target.host` / `share` | 字符串 | 仅 `smb-restic` 必填 |
| `storage.backup.schedule` | 五段 cron | `doctor` 会校验字段数量 |
| `storage.backup.retention` | `daily` 1–365 · `weekly` 0–52 · `monthly` 0–24 | 保留策略 |
| `remoteAccess.enabled` | 布尔 | `false` 时不发布任何端口 |
| `notifications.primary` | `none` · `qq` · `bark` | 非 `none` 时 `doctor` 会明确提示"连接器未实现" |
| `agent.enabled` | 布尔 | 默认 `false`；打开后 `doctor`/`plan` 都会标出"执行器未实现" |
| `capabilities.enabled` | 能力 id 数组 | 决定 `status` 探测哪些；重复 id 会被校验拒绝 |

**为什么用 JSON 而不是 YAML**：YAML 需要解析器，会破坏"零依赖"这条最有价值的性质。配置本身不复杂，注释写在本文档与 schema 里。

---

## 6. 能力清单

能力是 JSON 声明，描述"这东西是什么、怎么探测、碰哪些数据、要什么权限"。

```json
{
  "id": "local-backup",
  "title": "Local backup",
  "summary": "把配置与选定数据加密备份到本地或外接路径；NAS 可选。",
  "kind": "path",
  "optional": true,
  "probe": { "path": "~/Backups/Macmini-station" },
  "data": ["station.json", "state directory"],
  "permissions": ["read: configured data paths", "write: backup target path"]
}
```

### 支持的探测类型

| `kind` | 探测内容 | 失败时 |
|---|---|---|
| `path` | 路径是否存在 | 必选能力 → `critical`；`optional: true` → `warn` |
| `file-freshness` | 目录里最新文件的年龄 | 超过 `maxAgeHours` → `warn`/`critical` |
| `mount` | 挂载表里是否有该挂载点 | 未挂载 → `warn`/`critical` |
| `http` | GET 请求，状态码在 `expect` 里 | 网络错误受控返回，不会抛出 |

**未知 `kind` 一律报 `unknown`**，且**绝不会执行 manifest 里声明的任意命令**——这是刻意设计：能力清单来自文件，不能被当成脚本入口。

### 加载与覆盖

1. 先加载仓库自带的 `capabilities/*.json`；
2. 再加载运行目录的 `capabilities/*.json`，**同 id 覆盖自带项**（方便本机定制）。

自带两个示例：`local-backup`，以及 `http-endpoint`（URL 故意指向关闭端口，避免"模板探测通过"这种假成功）。

---

## 7. Profile

`profiles/macos-apple-silicon.json` 描述首个支持目标：

- 必备能力：`local-backup`、`http-endpoint` —— **都不需要外部依赖**
- 可选集成：`nas`、`tailscale`、`qq-notifications`
- 每条能力都写明前置条件，`plan` 会原样展示

新增 profile 只需要加一个 JSON 文件；`doctor` 遇到未知 profile 会 `warn` 而不是崩溃。

---

## 8. 目录结构

```
bin/station.js            命令入口（shebang）
src/cli.js                参数解析、命令分发、退出码
src/config.js             station.json 默认值/读写
src/schema.js             手写结构校验（与 schema/*.json 同步）
src/doctor.js             doctor 的 10 项检查
src/capabilities.js       能力清单加载、校验、探测调度
src/probes.js             http / path / mount / file-freshness 探针
src/plan.js               只读规划
capabilities/*.json       自带能力示例
profiles/*.json           机器 profile
schema/station.schema.json 配置契约
test/*.test.js            node:test 用例
.github/workflows/ci.yml  CI（含"零依赖"守卫）
```

模块之间只通过显式参数连接，探针全部支持注入 `fetchImpl` / `now` 等依赖，因此测试不需要网络、不需要真实挂载、不需要改系统。

---

## 9. 开发

```bash
npm test                          # 37 个用例，零依赖
node bin/station.js doctor        # 手动冒烟
```

CI（`.github/workflows/ci.yml`）做三件事：

1. **禁止运行时依赖**：`package.json` 的 `dependencies` 非空即失败；
2. **Node 20 / 22 / 24 矩阵**跑测试；
3. **CLI 冒烟**：`doctor --json`、`plan --json` 结构正确，且退出码不超过 1。

合并流程与 README 维护要求见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## 10. README 维护约定

**每次合并前必须更新本 README 中受影响的部分。** 这不是建议，是合并条件之一：

| 你的改动 | README 必须同步 |
|---|---|
| 新增/修改命令或参数 | 第 4 节命令表、示例输出 |
| 新增/修改配置字段 | 第 5 节字段表、`schema/station.schema.json` |
| 新增探测类型或能力字段 | 第 6 节探测类型表 |
| 新增 profile 或支持平台 | 第 7 节 |
| 增加/移动模块 | 第 8 节目录结构 |
| 改变开发流程或 CI 规则 | 第 9 节 |
| 完成一个里程碑 | 第 11 节路线图状态、顶部状态行 |
| 改变安全边界或许可证 | 第 12 节、第 13 节 |

PR 模板里有对应勾选项；合并者应在合并前逐项确认。**README 落后于代码，视为未完成。**

---

## 11. 路线图

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** | CLI 骨架、`station.json` schema、能力清单、`doctor`/`status`/`plan`/`init` | ✅ 已合并（`452848e`） |
| **M1** | `apply`（只创建目录/写配置/校验，不启动服务）、`verify`、`rollback` | ⏳ 进行中 |
| **M2** | 备份执行：restic 封装、local/USB/NAS 适配器、`check`、恢复演练 | 计划 |
| **M3** | 连接器：Tailscale、QQ、Bark，全部 opt-in，密钥走系统钥匙串 | 计划 |
| **M4** | Agent 任务执行：独立 worktree、repo allowlist、预算与时限、测试门槛 | 计划 |
| **M5** | GitHub CI/PR 集成：默认只开 Draft PR，人工合并后才允许发布 | 计划 |

后续里程碑都遵守同一条底线：**任何"会改变系统"的动作都必须先 `plan` 再 `apply`，并且可回滚。**

---

## 12. 安全边界

- 不替你 `git init`、不自动推送代码、不读取密钥文件。
- 能力探测只做 HTTP/路径/挂载/文件新鲜度检查，**不执行 manifest 声明的命令**。
- 配置文件不存明文凭据；连接器一律使用系统钥匙串引用。
- `agent.enabled` 在隔离 worktree、预算与测试门槛实现之前保持 `false`。
- 报告问题请不要贴 token、密钥或包含个人路径的完整日志。

---

## 13. 许可证

目前为 `UNLICENSED`（未选定许可证）。在明确许可证之前请勿对外分发。如果你打算公开复用，请先开 issue 讨论许可证选择。

---

## 14. 相关文档

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 开发流程、提交规范、README 规则
- [`schema/station.schema.json`](schema/station.schema.json) — 配置契约
- 设计背景：工作站规划文档（私有仓库外的笔记，不在本仓库内）