---
name: douyin-daily-report
description: "每天定时把 standalone/state/ 下的 audit.jsonl 与 video-cache.json 汇总成一份抖音接管日报。用户说『出个抖音日报』『每天汇总一下』『看看昨天回了几条』『待审积压多少』『定时报告怎么配』『日报没出来』『热门话题统计』『模型调用花了多少』时加载。⚠️ 含 <用户目录>/<项目路径>/<端口>/<通知渠道> 占位符，原样装不生效，必须先全部替换再安装。"
---

# ⚠️ 装之前必须改写（含占位符）

> **⚠️ 本文件含 `<用户目录>` / `<项目路径>` / `<端口>` / `<通知渠道>` 占位符，原样装不生效。**
> `skills-adapt/` 是「要改写」层：照抄进 `~/.agents/skills/` 不会报错，但一触发就指向不存在的路径，日报写不出来、定时任务也起不来。
> **先把下面清单里每一个占位符全部替换成你的实际值，再复制安装，最后新开会话触发一次试跑。**

| 占位符 | 换成什么 | 例（仅示意，别照抄） |
|---|---|---|
| `<用户目录>` | 你的系统用户目录 | Windows `C:/Users/<你的用户名>`；macOS/Linux `/home/<你的用户名>` 或 `/Users/<你的用户名>` |
| `<项目路径>` | 仓库 `dsh-douyin-bot-playbook` 的绝对路径，**用正斜杠** | `<用户目录>/Pictures/dsh-douyin-bot-playbook` |
| `<端口>` | 本地只读控制台端口，与 `config.json` 的 `console.port` 一致，默认 `3210` | `3210` |
| `<通知渠道>` | 可选推送目标（webhook / 邮件 / 本机文件），不推送就整段删掉 | 企业微信/钉钉/Slack webhook，或留空 |
| `<路径>` | 若你习惯用「路径」泛指上面的绝对路径，统一替换成同一个 `<项目路径>` | 同上 |

替换自检（在 PowerShell 里跑）：

```powershell
Select-String -Path "<项目路径>\skills-adapt\douyin-daily-report\SKILL.md" -Pattern "<用户目录>|<项目路径>|<端口>|<通知渠道>|<路径>"
```

**没有任何输出**才算替换干净。另外确认 `<项目路径>/standalone/state/` 里确实有 `audit.jsonl`、`approval.jsonl`、`video-cache.json`。

安装位置（替换完再拷）：

```text
Windows:  C:/Users/<用户目录>/.agents/skills/douyin-daily-report/SKILL.md
macOS/Linux:  ~/.agents/skills/douyin-daily-report/SKILL.md
```

frontmatter 必须有 `name` 与 `description`，DSH 才扫得到；仓库里改 `skills-adapt/` 不影响已装好的那份。

> **先问账号主人再装**：定时任务会常驻/开机触发、读本机 `state/`、可能产生一次外部推送。开之前说清楚「开什么、碰什么数据、花多少钱、怎么停」，等明确同意再注册计划任务；**没同意就不注册，也不要「先注册上再问」**。只在 `--dry` 下跑通链路的机器不需要这一步。

---

# 抖音接管 · 每日日报

## 1. 日报要统计什么（只读，不改配置、不点发送）

数据源全部来自 `<项目路径>/standalone/state/`：

| 指标 | 从哪算 | 口径 |
|---|---|---|
| 新增评论数 | `audit.jsonl` | 当日 `kind=polled` 的条数；再按 `channel` 分 `comment` / `dm` / `mention` |
| 回复数 | `audit.jsonl` | 当日 `kind=sent` 的条数（**只有真发出去的算**，`dry` / `queued` 不算） |
| 潜水数 | `audit.jsonl` | 当日 `kind=skipped` 且 `reason=silent` 或 `reason=model-error:*` 的条数 |
| 拦截数 | `audit.jsonl` | 当日 `kind=blocked` 全量 + `kind=skipped` 里非 silent 的（如 `denylist-keyword` / `empty-whitelist` / `not-in-whitelist`），按 `reason` 分组列 TOP |
| 热门话题 | `video-cache.json` | 聚合缓存条目里的 `topics[]`，按出现次数排 TOP 5；顺带列 `source=vision` 与 `source=cache` 条数 |
| 待审积压 | `approval.jsonl` | 当前 `status=pending` 的条数；另列已 `expired` 数（超过 `approvalTtlHours=24`） |
| 模型调用估算 | `audit.jsonl` + `video-cache.json` | `kind` 为 `draft`/`queued`/`sent`/`blocked` 且 `model` 非 `mock` 的去重 `itemId` 数 ≈ 文本决策次数；`video-cache.json` 当日新增且 `source=vision` 的条数 ≈ 视觉调用次数；`transcript` 非空的条数 ≈ ASR 次数。**是估算，不是账单** |
| 停机/异常 | `audit.jsonl` + `takeover.log` | 当日 `kind=error`（尤其 `reason=stop-signal` / `poll-failed`）条数，非 0 要标红 |

输出到：`<项目路径>/standalone/state/daily-YYYY-MM-DD.md`（`state/` 已被 `.gitignore` 排除，不会进仓库）。可选推送到 `<通知渠道>`。

> 频率闸只统计 `sent`，所以 dry-run 跑再多也不会把额度耗掉——日报里「回复数」为 0 而「潜水数 / 拦截数」很高，通常是**默认全关**在起作用，不是坏了。

## 2. 汇总脚本（Node，只读）

把下面存成 `<项目路径>/standalone/tools/daily-report.mjs`。它只 `readFileSync` 四个 state 文件，不 import `takeover.mjs`、不启动浏览器、不调模型、不写 `config.json`、不点发送。

```js
#!/usr/bin/env node
/** daily-report.mjs —— 只读汇总 state/，输出 state/daily-YYYY-MM-DD.md */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STANDALONE = fileURLToPath(new URL('..', import.meta.url));
const STATE = path.join(STANDALONE, 'state');
const day = (process.argv[2] || new Date().toISOString().slice(0, 10));
const dayStart = new Date(`${day}T00:00:00.000Z`).getTime();
const dayEnd = dayStart + 86400_000;

const readJsonl = (f) => {
  try {
    return fs.readFileSync(path.join(STATE, f), 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
};
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); }
  catch { return {}; }
};
const inDay = (r) => {
  const t = Date.parse(r.ts || '');
  return Number.isFinite(t) && t >= dayStart && t < dayEnd;
};
const countBy = (rows, fn) => rows.reduce((m, r) => {
  const k = fn(r) || 'unknown'; m[k] = (m[k] || 0) + 1; return m;
}, {});
const top = (obj, n = 5) => Object.entries(obj)
  .sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- （无）';

const audit = readJsonl('audit.jsonl').filter(inDay);
const approvals = readJsonl('approval.jsonl');
const cache = readJson('video-cache.json');
const cacheRows = Array.isArray(cache) ? cache : Object.values(cache.entries || cache || {});

const polled = audit.filter((r) => r.kind === 'polled');
const sent = audit.filter((r) => r.kind === 'sent');
const silent = audit.filter((r) => r.kind === 'skipped' && /^silent|^model-error/.test(r.reason || ''));
const blocked = audit.filter((r) => r.kind === 'blocked');
const skippedOther = audit.filter((r) => r.kind === 'skipped' && !/^silent|^model-error/.test(r.reason || ''));
const errors = audit.filter((r) => r.kind === 'error');

const byChannel = countBy(polled, (r) => r.channel);
const blockReasons = { ...countBy(blocked, (r) => r.reason), ...countBy(skippedOther, (r) => r.reason) };
const topics = {};
let visionCalls = 0, cacheHits = 0, asrCalls = 0;
for (const c of cacheRows) {
  if (!c || typeof c !== 'object') continue;
  for (const t of (Array.isArray(c.topics) ? c.topics : [])) topics[t] = (topics[t] || 0) + 1;
  if (c.source === 'vision') visionCalls += 1;
  if (c.source === 'cache') cacheHits += 1;
  if (c.transcript) asrCalls += 1;
}
const pending = approvals.filter((r) => r.status === 'pending').length;
const expired = approvals.filter((r) => r.status === 'expired').length;
const textCalls = new Set(audit
  .filter((r) => ['draft', 'queued', 'sent', 'blocked', 'dry'].includes(r.kind) && r.model && r.model !== 'mock')
  .map((r) => r.itemId || r.approvalId || r.ts)).size;

const channelLines = Object.entries(byChannel).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- （无）';
const md = `# 抖音接管日报 ${day}

> 只读汇总，来源：standalone/state/（audit.jsonl / approval.jsonl / video-cache.json）。
> 频率为估算，不是账单；默认全关时「回复数 0」属正常。

## 概览
| 指标 | 数值 |
|---|---|
| 新增消息（polled） | ${polled.length} |
| 回复数（sent） | ${sent.length} |
| 潜水数（silent / model-error） | ${silent.length} |
| 拦截数（blocked + 非 silent skipped） | ${blocked.length + skippedOther.length} |
| 待审积压（pending） | ${pending} |
| 过期草稿（expired） | ${expired} |
| 异常 / 停机（error） | ${errors.length} |

## 分渠道
${channelLines}

## 拦截原因 TOP
${top(blockReasons, 8)}

## 热门话题 TOP 5（video-cache.json topics 聚合）
${top(topics, 5)}

## 模型调用估算
- 文本决策（去重 itemId，排除 mock）：约 ${textCalls} 次
- 视觉调用（缓存里 source=vision）：${visionCalls} 次；缓存命中：${cacheHits} 次
- ASR 转写（有 transcript）：${asrCalls} 次

## 需要人工看一眼
${errors.length ? `- 有 ${errors.length} 条 error，查 takeover.log 里的 stop-signal / poll-failed` : '- 无异常记录'}
${pending ? `- 待审 ${pending} 条：cd <项目路径>/standalone && node takeover.mjs --pending，再 --approve <id> 逐条放行` : '- 待审队列为空'}
${expired ? `- ${expired} 条草稿已过期（approvalTtlHours=24），会自动作废，不用补批` : ''}
`;

const out = path.join(STATE, `daily-${day}.md`);
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(out, md, 'utf8');
console.log(`[daily-report] 已写出 ${out}`);
console.log(md.split('\n').slice(0, 12).join('\n'));

// 可选推送：把 <通知渠道> 换成你自己的 webhook；不推送就删掉整段
const HOOK = process.env.DOUYIN_REPORT_WEBHOOK || '';   // ← <通知渠道>
if (HOOK) {
  try {
    await fetch(HOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: `抖音日报 ${day}：新增 ${polled.length} / 回复 ${sent.length} / 潜水 ${silent.length} / 拦截 ${blocked.length + skippedOther.length} / 待审 ${pending}` } }),
      signal: AbortSignal.timeout(10000),
    });
    console.log('[daily-report] 已推送到 <通知渠道>');
  } catch (e) { console.warn('[daily-report] 推送失败（不影响日报文件）：', e.message); }
}
```

跑一次（不注册任何定时任务，先验证）：

```bash
cd <项目路径>/standalone
node tools/daily-report.mjs                 # 今天
node tools/daily-report.mjs 2026-11-05      # 指定某天
type state\daily-2026-11-05.md              # Windows；macOS/Linux 用 cat
```

验收：`<项目路径>/standalone/state/daily-YYYY-MM-DD.md` 生成，概览表数字与 `state/audit.jsonl` 对得上；`config.json`、`approval.jsonl`、`seen.json` 的修改时间**没变**。

## 3. 定时写法 A —— PowerShell 计划任务（Windows）

注册「每天 09:00 跑一次」，`<用户目录>` / `<项目路径>` 全部换成实际值。**先跑通第 2 节，再注册；注册前要账号主人明确同意**（这会创建开机触发的计划任务）。

```powershell
$Project = "<项目路径>\standalone"           # ← <项目路径>
$Node    = (Get-Command node).Source          # 或写死 node.exe 绝对路径
$Script  = Join-Path $Project "tools\daily-report.mjs"

$Action  = New-ScheduledTaskAction -Execute $Node -Argument "`"$Script`"" -WorkingDirectory $Project
$Trigger = New-ScheduledTaskTrigger -Daily -At "09:00"
$Principal = New-ScheduledTaskPrincipal -UserId "<用户目录>" -LogonType Interactive -RunLevel LeastPrivilege
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName "douyin-daily-report" `
  -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings `
  -Description "dsh-douyin-bot-playbook 只读日报"

# 立刻试跑一次 / 看状态 / 停用 / 删除
Start-ScheduledTask -TaskName "douyin-daily-report"
Get-ScheduledTaskInfo -TaskName "douyin-daily-report"
Disable-ScheduledTask -TaskName "douyin-daily-report"
Unregister-ScheduledTask -TaskName "douyin-daily-report" -Confirm:$false
```

或用 `schtasks`（更老派，替换同样占位符）：

```cmd
schtasks /Create /TN "douyin-daily-report" /SC DAILY /ST 09:00 ^
  /TR "\"<Node路径>\" \"<项目路径>\standalone\tools\daily-report.mjs\"" ^
  /RU "<用户目录>"
```

Windows 下若脚本里用了 `<端口>` 的控制台接口替代读文件，注意 `console.enabled` 默认关，日报脚本**不要依赖控制台**——直接读 `state/` 最稳。

## 4. 定时写法 B —— Node 自身定时 / cron

**B1 · 常驻进程内定时**（不装额外依赖，用 `setTimeout` 对齐到下一个本地 09:00）：

把下面存成 `<项目路径>/standalone/tools/daily-report-loop.mjs`，手动启动，不留开机自启：

```js
// node tools/daily-report-loop.mjs   （Ctrl+C 停）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const script = path.join(dir, 'daily-report.mjs');
const HOUR = 9;                       // 每天 09:00（本机时区）

function nextDelay() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(HOUR, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}
function run() {
  const child = spawn(process.execPath, [script], { cwd: dir, stdio: 'inherit' });
  child.on('exit', (code) => console.log(`[daily-report-loop] exit ${code}`));
}
console.log(`[daily-report-loop] 下次执行 ${new Date(Date.now() + nextDelay()).toLocaleString()}`);
setTimeout(function tick() { run(); setTimeout(tick, nextDelay()); }, nextDelay());
```

启动 / 停止：

```bash
cd <项目路径>/standalone
node tools/daily-report-loop.mjs        # 前台跑，Ctrl+C 停
```

**B2 · 系统 cron 调 Node**（macOS/Linux，不常驻进程）：

```cron
# crontab -e   （<项目路径> 换成实际绝对路径，正斜杠）
0 9 * * * cd <项目路径>/standalone && /usr/bin/env node tools/daily-report.mjs >> state/daily-report.log 2>&1
```

**B3 · 用 node-cron**（想写 cron 表达式时）：

```bash
cd <项目路径>/standalone
npm i node-cron
```

```js
import cron from 'node-cron';
import { spawn } from 'node:child_process';
cron.schedule('0 9 * * *', () => {
  spawn(process.execPath, ['tools/daily-report.mjs'], { cwd: process.cwd(), stdio: 'inherit' });
}, { timezone: 'Asia/Shanghai' });
```

## 5. 可选推送到 `<通知渠道>`

- 脚本末尾的 `DOUYIN_REPORT_WEBHOOK` 环境变量即 `<通知渠道>` 落点；不设就跳过推送，日报文件照常生成。
- 推送内容只放**聚合数字**，不要放 `audit.jsonl` 里的评论原文、`userId`、草稿全文、token 或路径。
- webhook 地址不要写死进脚本、不要进仓库（`state/` 与 `config.json` 已被 `.gitignore` 排除，但新建的脚本会进仓库）。用环境变量或本机未跟踪的配置文件。
- 推送失败只 `warn`，不影响日报文件，也不重试轰炸。

## 6. 日常运维与排错

| 现象 | 检查 | 处理 |
|---|---|---|
| 日报没出来 | `<项目路径>/standalone/state/` 是否存在且可写；计划任务 `LastRunTime` / `LastTaskResult`；cron 日志 `state/daily-report.log` | 手动 `node tools/daily-report.mjs` 先跑通；路径里还有 `<...>` 占位符就是没替换干净 |
| 全是 0 | 当天有没有跑过 `node takeover.mjs`；`audit.jsonl` 的 `ts` 是不是 UTC（脚本按 UTC 日界切） | 用 `node tools/daily-report.mjs 2026-11-05` 指定日期回看；0 是安全默认值，不是坏 |
| 路径找不到 / ENOENT | `<项目路径>` 是否用了反斜杠导致转义、`state.dir` 是否被改过 | 统一用正斜杠；确认 `config.json` 的 `state.dir=./state` |
| 权限拒绝 | 计划任务用了 `SYSTEM` 但 profile 在用户目录 | `-RunLevel LeastPrivilege` + `<用户目录>` 身份，或把 `<用户目录>` 换成实际账号名 |
| 数字和页面对不上 | 频率闸只数 `sent`；`dry` / `queued` / `blocked` 不算回复 | 以 `audit.jsonl` 为准，别拿待审队列当已发 |
| 想看更细 | `node takeover.mjs --pending`；只读控制台 `http://127.0.0.1:<端口>/?token=[CONSOLE_TOKEN]` 的 `/health` `/audit?limit=50` `/pending` | 控制台默认关、只绑 127.0.0.1、只有读接口；见 `douyin-console-ops` |

## 7. 边界（别越线）

- 日报**只读** `state/`，不写 `config.json`、不改 `seen.json` / `approval.jsonl`、不点发送、不批准草稿、不启动浏览器、不调模型。
- 不因为「待审积压多」就自动 `--approve`：放行是 `douyin-reply-discipline` 的事，必须人工逐条。
- 不把 `allowAllWhenEmpty` 改 true、不关 `safety` 规则、不绕过验证码或风控。
- 注册计划任务 / cron / 常驻 loop 属于「开机自启类拓展」，**先问账号主人，明确同意再注册**；不同意就只保留手动 `node tools/daily-report.mjs`。
- 怎么停：`Disable-ScheduledTask` / `Unregister-ScheduledTask`（Windows）、注释 crontab 行、Ctrl+C 结束 loop。停掉后已生成的 `daily-*.md` 保留。
- 仓库里 `skills-adapt/` 只是镜像；改完这份要重新拷到 `~/.agents/skills/douyin-daily-report/SKILL.md` 并重启 DSH 才生效。
