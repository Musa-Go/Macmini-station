# 运行 Agent 的隔离方案

`station worktree` 只隔离 **git 历史**，不隔离进程。任务和 agent 命令以**调用者的用户身份**运行，因此能读你的 `~/.ssh`、`~/Library/Keychains`、浏览器数据、以及该用户可访问的一切。

本文给出一个不需要虚拟机的加固路径：**用一个专用低权限账号运行 agent**，让工具本身仍由你日常账号操作。

> 结论先说：这不是"沙箱"，是**权限收敛**。它的价值在于把"agent 被提示注入后能做的事"从"你的一切文件"缩小到"一个你能审计的目录"。真正的强隔离仍然需要虚拟机或独立物理机。

---

## 1. 威胁模型

| 场景 | 无隔离时 | 专用账号后 |
|---|---|---|
| Agent 被仓库内恶意指令诱导，读取私钥 | 可读 `~/.ssh`、钥匙串 | 读不到（家目录是独立空目录） |
| 同上，写入系统其它位置 | 你的用户能写的地方都能写 | 只能写共享工作目录 |
| 同上，读取浏览器/邮件数据 | 可读 | 读不到 |
| 同上，装持久化后门（LaunchAgent） | 可装到你的 `~/Library/LaunchAgents` | 只能装在自己的受限目录，且不随你登录启动 |
| 同上，访问内网其它服务 | 可以 | 仍然可以（网络未隔离，见 §6） |

**没有覆盖的**：同机其它用户可读的文件、网络侧攻击、内核漏洞。要覆盖这些需要 VM。

---

## 2. 一次性准备（需要管理员权限，由你手动执行）

```bash
# 1) 创建专用标准用户，禁止登录图形界面
sudo sysadminctl -addUser station-agent \
  -fullName "Station Agent" \
  -shell /bin/zsh \
  -home /Users/station-agent \
  -password -

# 2) 不允许它 sudo
sudo dseditgroup -o edit -d station-agent -t user admin

# 3) 准备一个 agent 专用的工作根目录
sudo mkdir -p /Users/Shared/station-agent
sudo chown station-agent:staff /Users/Shared/station-agent
sudo chmod 750 /Users/Shared/station-agent

# 4) 把要交给 agent 的仓库复制/克隆到该目录，属主改为专用账号
sudo -u station-agent git clone <repo-url> /Users/Shared/station-agent/work
```

要用交互式密码也可以：`sudo sysadminctl -addUser station-agent -password`（会提示输入）。

第 4 步**不要**把仓库软链到你的主目录——软链会把权限绕过去。

---

## 3. 用专用账号运行 station

工具的配置与状态目录应属于专用账号，避免它写你的目录：

```bash
# 以专用账号初始化一套独立的 station 目录
sudo -u station-agent /usr/bin/env HOME=/Users/station-agent \
  node /path/to/Macmini-station/bin/station.js init

# 创建任务工作树（源仓库也在专用账号下）
sudo -u station-agent /usr/bin/env HOME=/Users/station-agent \
  node /path/to/Macmini-station/bin/station.js worktree create \
    --repo /Users/Shared/station-agent/work

# 跑 agent
sudo -u station-agent /usr/bin/env HOME=/Users/station-agent \
  node .../bin/station.js worktree agent <id> --prompt "..." --verify test
```

要点：

- `HOME` 必须显式改成专用账号的家目录，否则 node 会去读你家的 **git 全局配置**（其中可能有凭据 helper）。
- 不要 `export` 你的 API key 到这条命令的环境里；如确需网络模型调用，用专用账号自己的钥匙串或专用配置文件。
- 本工具的执行器已经把子进程环境裁剪为 `PATH/HOME/LANG/TERM`，但**上层调用者的 `HOME` 仍要正确**。

---

## 4. 让工具报告当前隔离状态

`station.json` 里声明你的部署意图：

```json
{
  "agent": {
    "enabled": true,
    "isolation": "dedicated-user"
  }
}
```

- `"none"`（默认）：`doctor` 会明确警告"agent 以你的用户身份运行，无 OS 隔离"。
- `"dedicated-user"`：`doctor` 会检查**当前进程用户是否与 `station.json` 的属主不同**；如果相同，说明你其实没有切换账号，仍会警告。

它不是安全边界，只是一致性检查——防止"以为自己隔离了，其实没有"。

---

## 5. 可选：用 launchd 定时跑

专用账号的 LaunchAgent 放在它自己的 `~/Library/LaunchAgents`，只在该账号有会话时启动，不会随你的登录自动执行：

```xml
<key>UserName</key><string>station-agent</string>
```

（在系统级 LaunchDaemon 里设置 `UserName` 才真正脱离你的会话；那需要 root 安装，属于更强的隔离，本文不展开。）

---

## 6. 明确的局限

| 局限 | 说明 |
|---|---|
| **网络未隔离** | 专用账号仍能访问内网与公网；要限制需要防火墙规则或 VM |
| **同机可读文件** | 文件权限为 `world-readable` 的路径它仍能读 |
| **共享工作目录** | 你与 agent 共用 `/Users/Shared/station-agent` 时，双方都能改；审计依赖 git 历史 |
| **不是沙箱** | 内核/容器级隔离不在本方案范围 |
| **重启后账号仍存在** | 这是有意为之：临时账号会让审计历史难以追踪 |

---

## 7. 判断标准

在把不可信仓库交给 agent 之前，先回答：

1. 这台机器上有没有它不该拿到的凭据？（SSH key、钥匙串、`.env`、云 CLI 配置）
2. 它的工作目录是否**只**包含该仓库？
3. 如果它今天被提示注入，最坏能写到哪？
4. 出问题后，你能从哪一份日志还原它做了什么？

四个问题里有一个答不上来，就应该先用虚拟机，而不是靠这套权限收敛。