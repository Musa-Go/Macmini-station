# 连接器设计（M3）

本文是 **M3 的设计契约**，不是实现说明。当前代码里只有配置校验与"未实现"的诚实提示；没有任何真实网络推送。

---

## 1. 支持范围

| 连接器 | 方向 | 用途 | 依赖 |
|---|---|---|---|
| `tailscale` | 入站 | 把选定端口发布到 tailnet，供自己的设备访问 | 本机已安装并登录 Tailscale |
| `qq` | 双向 | 接收指令、推送告警与日报 | 官方 QQ 开放平台机器人 AppID/AppSecret |
| `bark` | 出站 | 兜底推送（QQ 不可用时仍能收到告警） | Bark 设备 key |

三者**全部 opt-in**：默认 `notifications.primary: "none"`、`remoteAccess.enabled: false`，未配置时核心功能完整可用。

---

## 2. 凭据模型

**硬规则：配置文件里不出现任何密钥。**

| 连接器 | 配置里存什么 | 真实密钥放哪 |
|---|---|---|
| `tailscale` | 无（读本机 `tailscale status`） | Tailscale 自己的登录态 |
| `qq` | `appId`（非机密）+ **凭据引用名** | 系统钥匙串条目 |
| `bark` | **凭据引用名** | 系统钥匙串条目 |

引用形如 `"secretRef": "station.qq.appSecret"`。运行时通过系统钥匙串读取：

- macOS：`security find-generic-password -s station.qq.appSecret -w`
- 其它平台：M3 不承诺支持，`doctor` 会明确报 `unsupported platform for keychain`

**日志与错误信息一律不得包含秘密**；连接器返回的错误只带状态码、连接器名、阶段。

QQ 的 access token 同样按秘密处理：**只在内存中存活一次命令的时间**，不缓存到磁盘。代价是每次投递多一次 token 请求，换来"磁盘上没有长期凭据"。

---

## 3. 权限与副作用

| 连接器 | 会监听端口吗 | 会外连吗 | 失败时 |
|---|---|---|---|
| `tailscale` | 否（由 Tailscale 自身监听） | 否 | 保持 local-only，`doctor` 报 `warn` |
| `qq` | 否 | 是（出站 WebSocket） | 停止重连并降级到下一通知渠道 |
| `bark` | 否 | 是（HTTPS） | 记一次失败，不重试超过 N 次 |

任何连接器**不得**：
- 修改系统防火墙或 SSH 配置；
- 自动批准需要人工确认的操作；
- 把收到的消息当命令执行——指令解析独立于推送通道。

---

## 4. 推送语义

- **去重**：同 `(connector, title, body)` 5 分钟内只发一次
- **限速**：每分钟最多 20 条，超出写入本地队列并合并摘要
- **分片**：单条超过 1500 字节按句切分，带 `(1/3)` 序号
- **重试**：网络类失败退避重试 3 次（1s/4s/16s），鉴权类失败不重试并提示修凭据
- **落盘**：无论推送成功与否，都写一条本地审计记录（时间、连接器、状态、耗时），**不含正文中的秘密**

---

## 5. 指令面（仅 QQ）

M3 只实现**只读**指令，写操作留给 M4：

```
/status        机器与能力摘要
/backup status 最近一次备份与校验结果
/help          指令清单
```

- 只接受白名单用户（openid）
- 未知指令回固定帮助文本，不猜测意图
- 任何"帮我改点什么"的请求**明确拒绝**，指向 M4 的受控任务入口

---

## 6. 配置形状（M3 目标）

```json
{
  "remoteAccess": { "enabled": true, "provider": "tailscale", "ports": [8443] },
  "notifications": {
    "primary": "qq",
    "fallback": "bark",
    "qq": { "appId": "102xxxxx", "secretRef": "station.qq.appSecret", "allowFrom": ["<openid>"] },
    "bark": { "secretRef": "station.bark.key" }
  }
}
```

校验规则：

| 字段 | 规则 |
|---|---|
| `notifications.primary` | `none` / `qq` / `bark`；非 `none` 时必须提供对应连接器配置 |
| `notifications.fallback` | 必须与 `primary` 不同，可为空 |
| `*.secretRef` | 必须是非空字符串，且**不得**像真实密钥那样以 `sk-` / `oc_` / 长随机串出现（校验器会拒绝疑似明文） |
| `remoteAccess.ports` | 1–65535 的整数数组；启用时必须非空 |
| `qq.allowFrom` | 启用 QQ 时必须非空（否则任何人都能发指令） |

---

## 7. 里程碑切分

| 步骤 | 内容 | 验收 |
|---|---|---|
| **M3.1** | 配置形状 + 校验 + `doctor` 报告连接器状态（全部"未实现"） | 无网络行为，配置错了能明确报错 |
| **M3.2** ✅ | `bark` 推送（最简单、无入站） | 有去重/限速/分片/审计；失败可见 |
| **M3.3** ✅ | `qq` 出站推送 + 白名单 | 仅白名单 openid 能收到；秘密不进日志；token 只在内存 |
| **M3.4 ⏸** | `qq` 入站只读指令 | 暂缓：需要常驻进程，形态待定，见 [DECISIONS-PENDING](DECISIONS-PENDING.md) D1 |
| **M3.5** ✅ | `tailscale` 端口发布（opt-in） | 关闭时保持 local-only；开启后仅 tailnet 可达；只发明确列出的端口 |

M3.1 是纯校验层，可以先做并且零风险；后续每一步都只在用户显式开启对应连接器时生效。

---

## 8. 明确不做

- 不做公网暴露（funnel / 端口转发）
- 不做多用户、多租户
- 不做消息内容持久化（只留审计元数据）
- 不做"聊天即执行"的隐式授权
- 不在 M3 里做任何代码修改类指令（属于 M4，且需要独立 worktree、预算与测试门槛）