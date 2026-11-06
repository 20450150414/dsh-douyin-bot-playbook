---
name: douyin-console-ops
description: "本地只读控制台 127.0.0.1:<端口> 的日常运维。用户说『打开抖音控制台』『控制台打不开』『3210 端口不通』『端口被占用』『看待审队列』『看审计尾部』『健康检查 /health』『401 unauthorized』『token 怎么配』『控制台能不能批准/发送』『日报里的数哪来的』时加载。含开/关、DOUYIN_CONSOLE_TOKEN、/health /audit /pending /state 四个只读接口、端口占用排查、不要暴露公网、不要开写接口。⚠️ 含 <用户目录>/<项目路径>/<端口>/[CONSOLE_TOKEN] 占位符，原样装不生效，必须先全部替换再安装。"
---

# ⚠️ 装之前必须改写（含占位符）

> **⚠️ 本文件含 `<用户目录>` / `<项目路径>` / `<端口>` / `[CONSOLE_TOKEN]` 占位符，原样装不生效。**
> `skills-adapt/` 是「要改写」层：照抄进 `~/.agents/skills/` 不会报错，但一触发就指向不存在的路径与端口。
> **先把下面清单里每一个占位符全部替换成你的实际值，再复制安装，最后新开会话触发一次试跑。**

| 占位符 | 换成什么 | 例（仅示意，别照抄） |
|---|---|---|
| `<用户目录>` | 你的系统用户目录 | Windows `C:/Users/<你的用户名>`；macOS/Linux `/home/<你的用户名>` |
| `<项目路径>` | 仓库 `dsh-douyin-bot-playbook` 的绝对路径，**用正斜杠** | `<用户目录>/Pictures/dsh-douyin-bot-playbook` |
| `<端口>` | 本地只读控制台端口，与 `config.json` 的 `console.port` 一致，默认 `3210` | `3210` |
| `[CONSOLE_TOKEN]` | 自己生成的一段随机串，或改用环境变量 `DOUYIN_CONSOLE_TOKEN`（推荐） | `openssl rand -hex 16` 的输出 |
| `<路径>` | 若你习惯用「路径」泛指绝对路径，统一替换成同一个 `<项目路径>` | 同上 |

替换自检：

```powershell
Select-String -Path "<项目路径>\skills-adapt\douyin-console-ops\SKILL.md" -Pattern "<用户目录>|<项目路径>|<端口>|\[CONSOLE_TOKEN\]|<路径>"
```

**没有任何输出**才算替换干净。

安装位置（替换完再拷）：

```text
Windows:  C:/Users/<用户目录>/.agents/skills/douyin-console-ops/SKILL.md
macOS/Linux:  ~/.agents/skills/douyin-console-ops/SKILL.md
```

frontmatter 必须有 `name` 与 `description`，DSH 才扫得到；仓库里改 `skills-adapt/` 不影响已装好的那份。

> **先问账号主人再开**：`console.enabled=true` 会起一个本机 HTTP 服务、常驻随主循环、暴露（脱敏后的）审计与待审草稿。开之前说清楚「开什么、绑哪里、谁能看、怎么停」，等明确同意再改。**没同意就不开，也不要「先开上再问」**。默认 `console.enabled=false`。

---

# 抖音接管 · 本地只读控制台运维

## 1. 它是什么、不是什么

`standalone/src/console.mjs` 是一个**只绑本机、只有 GET 读接口**的 HTTP 服务，随 `takeover.mjs` 主循环一起启动/关闭：

- 能看：`/health`（状态与计数）、`/audit?limit=N`（审计尾部）、`/pending`（待审队列，脱敏）、`/state`（只读快照）。
- **没有写接口**：不能改配置、不能批准、不能发送、不能删 `state/`、不能触发轮询。要批准只能用 CLI `node takeover.mjs --approve <id>`（且会复审频率/密钥，见 `douyin-reply-discipline`）。
- `console.host=127.0.0.1`（默认），端口 `<端口>`（默认 `3210`）。**不提供、也不要自己加**任何 POST/PUT/DELETE 路由。
- 日志与控制台展示走 `util.mjs` 的 `redact()`：`sk-` / `Bearer` / `api_key=` / Windows 路径会换成 `<redacted>`。
- 控制台**默认关**；`--fixture --dry --once` 演示里也是关的，日报类统计请直接读 `state/` 文件，别依赖控制台在线（见 `douyin-daily-report`）。

访问地址：

```text
http://127.0.0.1:<端口>/?token=[CONSOLE_TOKEN]
```

token 也可放请求头 `x-console-token: [CONSOLE_TOKEN]`。两者都没有或不一致 → `401 {"error":"unauthorized"}`。

## 2. 开 / 关

### 开（改 `<项目路径>/standalone/config.json`，改前备份 .bak）

```json
"console": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": <端口>,
  "token": "[CONSOLE_TOKEN]"
}
```

**推荐用环境变量，不把 token 写进文件**（`src/config.mjs` 里环境变量优先级高于配置文件）：

```bash
# Windows PowerShell
$env:DOUYIN_CONSOLE_TOKEN = "<你生成的随机串>"
cd <项目路径>\standalone
node takeover.mjs --dry

# macOS/Linux
export DOUYIN_CONSOLE_TOKEN="<你生成的随机串>"
cd <项目路径>/standalone && node takeover.mjs --dry
```

生成随机串：

```bash
openssl rand -hex 16
# 或 PowerShell：
# -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

⚠️ `--dry` 是刻意选的：开控制台不等于开自动回复。`reply.enabled=false` / `dryRun=true` / `requireHumanApproval=true` 全部保持默认。开控制台**不改变任何放行规则**。

启动日志里应出现：

```text
[INFO] 只读控制台已启动 http://127.0.0.1:<端口>/?token=<CONSOLE_TOKEN>（只读，不暴露写接口）
```

### 关

- 临时关：`Ctrl+C` 结束主循环，`shutdown()` 会调 `stopConsole(server)` 并 `closeBrowser()`；日志打印「=== 结束 ===」。
- 配置关：把 `console.enabled` 改回 `false`（或删掉 `DOUYIN_CONSOLE_TOKEN` 并重启），下次启动不再监听。
- **不要**为了「关掉」去 kill 浏览器进程或删 `state/` 账本。

`node takeover.mjs --once` / `--pending` / `--approve` 这些一次性命令在 `startConsole()` 之前就 `return` 了，**不会**起控制台；只有主循环会起。

## 3. 日常四件事

### 3.1 健康检查

```bash
curl "http://127.0.0.1:<端口>/health?token=[CONSOLE_TOKEN]"
```

```powershell
Invoke-RestMethod "http://127.0.0.1:<端口>/health?token=[CONSOLE_TOKEN]" | ConvertTo-Json -Depth 5
```

返回字段：

```json
{
  "ok": true, "ts": "2026-11-06T09:00:00.000Z", "demo": false,
  "dryRun": true, "replyEnabled": false,
  "counts": { "polled": 12, "skipped": 5, "queued": 4, "blocked": 1 },
  "pending": 4, "seen": 12, "videoCache": 3
}
```

看三件事：`ok=true`；`dryRun` / `replyEnabled` 是否符合预期（默认应是 `true` / `false`）；`counts` 里有没有 `sent`（默认全关时**不该有**）。`/` 与 `/health` 等价。

### 3.2 看待审队列

```bash
node takeover.mjs --pending          # CLI 首选，列 ID / 渠道 / 用户 / 原因 / 草稿
curl "http://127.0.0.1:<端口>/pending?token=[CONSOLE_TOKEN]"
```

`/pending` 返回 `rows`，每条的 `texts` 已 `redact()` 脱敏。要放行：

```bash
node takeover.mjs --approve ap_xxxxxxxxxx
node takeover.mjs --reject  ap_xxxxxxxxxx
```

**控制台不能批准**——这是设计，不是缺功能。批准会重新跑 `evaluate()` 复审密钥/长度/频率，且超过 `approvalTtlHours=24` 的草稿直接作废。

### 3.3 看审计尾部

```bash
curl "http://127.0.0.1:<端口>/audit?limit=50&token=[CONSOLE_TOKEN]"
```

`limit` 会被夹到 `1..200`，默认 30。等价的本地读法（控制台没开时用它）：

```powershell
Get-Content "<项目路径>\standalone\state\audit.jsonl" -Tail 20
```

```bash
tail -n 20 <项目路径>/standalone/state/audit.jsonl
```

每行字段：`ts` / `kind`（`polled` / `skipped` / `draft` / `queued` / `sent` / `blocked` / `error`，实现里另有 `dry`）/ `channel` / `itemId` / `userId` / `text` / `reason` / `decision` / `model`，附加 `approvalId` / `forced` / `messageCount`。排错先看 `kind` + `reason`。

`/state` 给只读快照：`counts` + `pending`（`approvals.list().length`），字段比 `/health` 少，适合探活。

### 3.4 看日志

```powershell
Get-Content "<项目路径>\standalone\state\takeover.log" -Tail 30
```

## 4. 端口占用排查

启动日志若出现 `控制台启动失败 { error: "listen EADDRINUSE: address already in use 127.0.0.1:<端口>" }`：

```powershell
# Windows
Get-NetTCPConnection -LocalPort <端口> -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
Get-Process -Id <OwningProcess> | Select-Object Id, ProcessName, Path
netstat -ano | findstr ":<端口>"
```

```bash
# macOS / Linux
lsof -i :<端口>
ss -ltnp | grep <端口>
```

处理顺序：

1. 先确认占用的是不是**自己上一次没退干净的 `takeover.mjs`** —— 是就正常 `Ctrl+C` 收尾，别直接 kill 浏览器。
2. 是别的程序 → **换端口**，改 `console.port` 与访问 URL 里的 `<端口>`，两边保持一致；改前备份 `config.json`。
3. 不要为了「通」去改 `console.host`（见第 5 节），不要关防火墙放行，不要kill 掉不认识的进程。
4. 换完重启，重新跑 `/health`。

`server.on('error')` 只记日志、**不会让主循环崩**，所以端口占用时轮询链路仍在跑；别以为「脚本还在跑 = 控制台起来了」，一定要 `/health` 验一次。

## 5. 不要暴露到公网（硬边界）

| 必须 | 禁止 |
|---|---|
| `console.host` 保持 `127.0.0.1` | 改成 `0.0.0.0` / `::` / 本机局域网 IP |
| 只在本机浏览器打开 | 端口转发、内网穿透、ngrok/frp、云反向代理、把 URL 发到群里 |
| token 用 `DOUYIN_CONSOLE_TOKEN` 或本机 `config.json` | 把 `[CONSOLE_TOKEN]` 贴进日志、提交、日报、外部推送 |
| 防火墙不放行 `<端口>` | 为「方便远程看」加入站规则 |
| 只有四个 GET 路由 | 自己加 POST 批准/发送/改配置接口 |

原因很直接：控制台能看到 `audit.jsonl` 尾部和待审草稿（虽然已脱敏），一旦暴露到公网等于把账号的互动记录挂出去。它**只读**还不够，必须**只本机**。

`node tools/verify.mjs` 里「自动发送默认收敛」「白名单 fail-closed」这些检查不受控制台开关影响；开控制台也不会放宽任何一条。

## 6. 不要开写接口

`console.mjs` 的 `switch (u.pathname)` 只有 `/`、`/health`、``/audit`、`/pending`、`/state`，默认 `404 { error:'not found', hint:'/health /audit /pending /state' }`。没有写路由，是刻意的：

- 批准草稿 → CLI `--approve`（带复审 + 过期作废 + `audit: sent, reason=human-approved`）。
- 改配置 → 只在本机编辑 `config.json`，改前 `.bak` 备份，改完 `verify.mjs` 回归。
- 发送 → 只由 `actions.mjs` 在 `decision='send'` 且 `dryRun=false` 时发生，与控制台无关。

如果有人要求「在控制台加个一键批准按钮」，按 `docs/RULES.md` 与 `douyin-reply-discipline` 回：放行逻辑只能待在 `policy.mjs` + CLI，不放进 HTTP 层。

## 7. 排错速查

| 现象 | 定位 | 处理 |
|---|---|---|
| 打不开 / 连接被拒 | `console.enabled` 是否 true；是否用了 `--once` / `--pending` / `--approve`（一次性命令不起控制台）；主循环是否还在跑 | 用 `node takeover.mjs --dry` 起主循环，看启动日志有没有「只读控制台已启动」 |
| `401 unauthorized` | URL 里 `token=` 与 `console.token` / `DOUYIN_CONSOLE_TOKEN` 是否一致；`[CONSOLE_TOKEN]` 是不是还没替换 | 改用请求头 `x-console-token`；确认环境变量在当前 shell 里生效（每个新 shell 都要重新设）；`config.json` 里若仍是 `[CONSOLE_TOKEN]` 占位符，token 就是这个字面量，别把它当真凭据 |
| 启动日志报 `EADDRINUSE` | 见第 4 节 | 先收尾旧进程，再换端口；两边 `<端口>` 一起改 |
| `/health` 里 `pending` 一直涨 | `requireHumanApproval=true` 时草稿本来就进队列 | `--pending` 看、`--approve` 逐条放；别为了「清空」去关人工放行 |
| `counts` 里出现 `sent` 但没批准过 | `reply.dryRun=false` + `requireHumanApproval=false` 被谁改了 | 立刻 `Ctrl+C`，把 `dryRun=true` / `requireHumanApproval=true` / `reply.enabled=false` 改回，`--dry` 复现；查 `audit.jsonl` 的 `reason` |
| 看到脱敏标记 `<redacted>` | `redact()` 正常工作 | 正常，不是数据坏了；要原文看本机 `state/audit.jsonl`（别外发） |
| 页面出现验证码 / 操作过于频繁 | `checkSignals()` 抛 `StopSignal`，主循环停机，控制台随 `stopConsole()` 一起关 | 立刻停机人工处理，不重试、不换号、不绕过；控制台打不开是停机的结果，不是故障 |
| 选择器过期读到 0 条 | `/health` 的 `counts.polled` 不涨 | 跑 `node tools/capture-selectors.mjs` 重抓快照，写 `selectors.local.json`；见 `douyin-takeover-setup` |

## 8. 边界与停法

- 控制台只读、只本机、默认关；开它**不等于**开自动回复，`reply.*` / `inbox.*` / `safety.*` 一个都不动。
- 不开机自启、不注册服务/计划任务；要看每天汇总用 `douyin-daily-report`（且同样要先问主人）。
- 不绕过验证码或风控；登录失效 / 验证码 / 操作过于频繁 → 立刻停机。
- 怎么停：`Ctrl+C`（主循环收尾会自动 `stopConsole` + `closeBrowser`）；配置关把 `console.enabled=false`；清除 `DOUYIN_CONSOLE_TOKEN` 后重启。停掉后 `state/` 下 `audit.jsonl` / `approval.jsonl` / `seen.json` / `video-cache.json` / `takeover.log` 全部保留，可回放。
- 仓库里 `skills-adapt/` 只是镜像；替换完占位符要重新拷到 `~/.agents/skills/douyin-console-ops/SKILL.md` 并重启 DSH 才生效。
