# standalone —— 独立接管版（不需要 DSH）

一份能跑的 Node 脚本：驱动**你自己登录的浏览器**读评论/私信 → 理解视频 → 模型出草稿 → 放行判定 → 回发 → 审计。

**默认全关、dry-run、人工放行。** 不抓包、不伪造签名、不绕过验证码/风控；遇到登录失效或风控提示立刻停机。

```
inbox.mjs → video.mjs → brain.mjs → policy.mjs → actions.mjs → audit.jsonl
   ↑            ↑           ↑            ↑            ↑
 只读 DOM    抽帧/视觉    人格/上下文   四道闸      发送/待审
```

## 五分钟离线演示（零依赖、不联网、不发送）

```bash
cd standalone
node takeover.mjs --fixture --dry --once
```

Windows 一样：

```powershell
cd standalone
node .\takeover.mjs --fixture --dry --once
```

这一步用 `fixtures/inbox-sample.json` 的假消息、`fixtures/video-summary-sample.json` 的假视频摘要、固定假模型决策，跑完整链路。你会看到：

- 广告评论被 `denylist-keyword` 跳过
- 注入评论被 `injection-suspect` **强制转人工**
- 纯表情评论 `[SILENT]` 潜水
- 带 `videoId` 的评论拿到视频摘要
- 正常评论生成草稿 → 因 `human-approval` 进入待审队列
- 全程只写 `state/audit.jsonl`，`kind` 里**没有 `sent`**

跑完看结果：

```bash
node takeover.mjs --pending                 # 看待审草稿
node takeover.mjs --reject ap_xxxxxxxxxx   # 丢弃一条
node takeover.mjs --approve ap_xxxxxxxxxx # 人工放行（dry-run 下仍不会真发）
type state\audit.jsonl                     # Windows
cat state/audit.jsonl                      # macOS/Linux
```

> 离线演示刻意旁路了「开关 / 渠道 / 白名单」三闸（否则空白名单会把样例全拦掉），日志里会明确打 `[fixture] 离线演示已旁路…`。**黑名单、注入检测、密钥拦截、长度、频率闸、人工放行一个都没旁路**，真机模式一律 fail-closed。

## 两种「读/写」后端

| 后端 | 怎么切 | 靠什么 | 装什么 |
|---|---|---|---|
| `dom` | 默认 | 自己解析页面 DOM + `src/selectors.mjs` | Node + Playwright |
| `mcp` | `--mcp` 或 `douyin.backend="mcp"` | `vendor/douyin-mcp`（从页面自身 XHR 取数，带提交回执） | Python venv + MCP 依赖 |

真接账号走 `mcp` 这条路，别自己跟哈希类名硬碰：

```powershell
cd standalone
powershell -ExecutionPolicy Bypass -File tools\setup-mcp.ps1   # 建 venv + 装 mcp<2 / playwright
node takeover.mjs --selfcheck                                  # 工具清单 + 登录态 + 上游自检
node takeover.mjs --login                                      # 出二维码 → 手机抖音扫 → 轮询登录结果
node takeover.mjs --mcp --dry --once                           # 读真评论/真私信 + 真看视频，只出草稿不发送
```

`--mcp` 只放开「读」和「理解」，**不碰任何发送开关**。发送要三道刹车同时开：

```
① config.reply.enabled=true 且 dryRun=false
② 本仓库据此给子进程传 DOUYIN_ALLOW_WRITES=1（mcp.allowWrites=false 可单独掐断这一步）
③ 上游在该变量为 1 时才把 douyin_comment / douyin_chat_send 注册成工具
```

默认状态下不是「选择不发」，而是那个 Python 进程里**没有发消息这个工具**——被诱导的模型调不到不存在的东西。能力层的来源、署名与边界见 `../vendor/douyin-mcp/NOTICE.md`。

## 离线回归（不碰账号也能验 --mcp 链路）

```bash
node tests/mcp-smoke.mjs
```

用 `tests/mock-mcp-server.mjs` 假装能力层（返回形状对齐上游），跑 23 项断言：归一化、四道闸、去重 + `exclude_cids`、未登录停机、人工放行受 dry-run 约束。改 `policy` / `actions` 后先跑这个，再碰真账号。

## 一键启动 / 停止（Windows）

`tools/start.ps1` 与 `tools/stop.ps1` 是幂等的常驻启动器：后台隐藏运行、自动找 `node.exe`、写 `state/daemon.pid`、把 stdout/stderr 重定向到 `state/daemon.*.log`，重复执行不会起第二个进程抢端口。

```powershell
cd standalone
# 默认：离线演示 + dry-run 常驻（最安全，开箱即跑）
powershell -ExecutionPolicy Bypass -File tools\start.ps1

# 只跑一轮就退出
powershell -ExecutionPolicy Bypass -File tools\start.ps1 -Once

# 真机只读（需先 npm install && npx playwright install chromium，并手动扫码登录一次）
powershell -ExecutionPolicy Bypass -File tools\start.ps1 -Real

# 停止
powershell -ExecutionPolicy Bypass -File tools\stop.ps1
```

启动器**永远强制 `--dry`**；要真正发送必须在 `config.json` 里显式开 `reply.enabled` / `dryRun=false` / 白名单 / 人工放行，不能靠启动参数绕过。`start.ps1` 启动后会直接打印只读控制台与待审队列的完整 URL。

非 Windows 用等价命令常驻即可：

```bash
nohup node takeover.mjs --fixture --dry > state/daemon.out.log 2>&1 &
echo $! > state/daemon.pid
kill "$(cat state/daemon.pid)"
```

> `.ps1` 文件带 UTF-8 BOM，Windows PowerShell 5.1 才能正确读中文输出；用 `pwsh` 7 也没问题。

## 接真账号（仍然先看不回）

```bash
cd standalone
cp ../config/config.example.json config.json     # Windows: copy ..\config\config.example.json config.json
npm install                                     # 装 playwright
npx playwright install chromium                  # 装浏览器内核
node tools/verify.mjs                            # 自检
```

填 `config.json`（见 `../config/FILL.md`），然后：

1. **扫码登录一次**：推荐设 `browser.cdpEndpoint` 接管你已开着的浏览器；否则用 `account.profileDir` 持久化 profile，第一次启动会开一个可见窗口，手动扫码。
2. **改选择器**（几乎必做）：`node tools/capture-selectors.mjs`，照着 `state/selector-candidates.json` 改 `src/selectors.mjs`，或写 `selectors.local.json` 覆盖。
3. **只读验活**：`node takeover.mjs --dry --once`，确认能读到评论/私信条数。
4. **挂机观察**：`node takeover.mjs --dry`，看 `state/takeover.log` 有没有异常停机。

> 页面改版后 `--dry` 读到 0 条是**安全的失败**，脚本不会瞎猜着往外发。这时候回去跑第 2 步。

## 开启自动回复（要账号主人明确同意）

```text
reply.enabled=true
reply.dryRun=false
reply.requireHumanApproval=true          ← 先别关
reply.replyToComments=true               ← 先只开评论
reply.whitelist.userIds=["<你的小号>"]
reply.maxRepliesPerHour=3
```

```bash
node takeover.mjs                 # 正式跑（生成草稿进待审）
node takeover.mjs --pending       # 看
node takeover.mjs --approve <id> # 逐条放行
```

跑满一天、确认语气对、没串台、没误发之后，再考虑开私信 (`replyToDMs`)、放宽白名单、关人工放行。**评论和私信是两个独立开关，别一起开。**

## CLI

| 命令 | 作用 |
|---|---|
| `--fixture` | 假消息 + 假模型 + 假视频摘要（不碰浏览器、不联网） |
| `--dry` | 强制 dryRun，不点发送按钮，只写 `kind=dry` |
| `--once` | 只跑一轮就退出 |
| `--pending` | 列出待审草稿 |
| `--approve <id>` | 人工放行（会复审频率/密钥；过期草稿作废） |
| `--reject <id>` | 丢弃草稿 |
| `--config <path>` | 指定配置文件 |
| `-h / --help` | 帮助 |

环境变量优先于配置文件：`DOUYIN_LLM_API_KEY` / `DOUYIN_ASR_API_KEY` / `DOUYIN_CONSOLE_TOKEN`。

## 只读控制台（默认关）

```text
console.enabled=true
console.token=<随机串>   或 DOUYIN_CONSOLE_TOKEN
```

`http://127.0.0.1:3210/?token=<CONSOLE_TOKEN>`

- `/health` 状态与计数
- `/audit?limit=50` 审计尾部
- `/pending` 待审队列（脱敏）

**只有读接口**，不能改配置、不能批准、不能发送；默认只绑 `127.0.0.1`。

## 目录

```
standalone/
├─ takeover.mjs          主循环 + CLI
├─ package.json
├─ README.md             本文件
├─ config.json           ← 你自己创建，已被 .gitignore 排除
├─ selectors.local.json  ← 可选本地覆盖，已被排除（模板见下方）
├─ src/
│   ├─ config.mjs        配置 + 路径解析（所有相对路径以 standalone/ 为基准）
│   ├─ util.mjs          日志 / JSONL / 正则 / 分条 / 脱敏
│   ├─ state.mjs         seen / audit / approvals / videoCache 四个账本
│   ├─ selectors.mjs     ★ 页面选择器观察记录（改版就改这里）
│   ├─ browser.mjs       Playwright 惰性加载、异常信号检测、DOM 导出
│   ├─ inbox.mjs         轮询 + 统一消息对象 + 稳定去重 id
│   ├─ video.mjs         抽帧 → 视觉模型 → 结构化摘要（可选 ASR）+ 缓存
│   ├─ brain.mjs         提示词拼装 + 外来文本包成 data + 模型/ mock
│   ├─ policy.mjs        ★ 四道闸：开关 / 白名单 / 频率 / 人工放行 + 注入与密钥拦截
│   ├─ actions.mjs       审计 / 待审 / dry / 真发送 / approve / reject
│   └─ console.mjs       本地只读 HTTP 控制台
├─ fixtures/             离线演示假数据
├─ tools/
│   ├─ verify.mjs                 离线自检
│   ├─ capture-selectors.mjs      DOM 快照 + 候选选择器
│   └─ start.ps1 / stop.ps1       Windows 幂等常驻启动器（写 state/daemon.pid）
└─ state/                ← 运行时产物，已被 .gitignore 排除
```

`selectors.local.json` 示例（只需写要覆盖的字段）：

```json
{
  "comment": {
    "card": "[data-e2e=\"comment-item\"]",
    "text": "[data-e2e=\"comment-content\"]",
    "submitButton": "button:has-text(\"发送\")"
  }
}
```

## 审计字段

`state/audit.jsonl` 每行一条：

```json
{"ts":"2026-11-06T09:00:00.000Z","kind":"queued","channel":"comment","itemId":"cmt_1001","userId":"u_fictional_01","reason":"human-approval","model":"mock","approvalId":"ap_ab12cd34ef","text":"这个我回头看看 | 有进展再说"}
```

`kind`：`polled` / `skipped` / `draft` / `queued` / `dry` / `sent` / `blocked` / `error`。
频率闸只统计 `sent`，所以 dry-run 随便跑不会把额度耗掉。

## 失败语义（重要）

| 情况 | 行为 |
|---|---|
| 登录失效 / 验证码 / 操作过于频繁 | 抛 `StopSignal`，**立刻停机**，不重试不换号不绕过 |
| 选择器失效 | 读到 0 条，安静结束，绝不误发 |
| 模型 401 / 超时 / 返回乱码 | 本条 `[SILENT]`，不重放旧回复 |
| 视觉模型 / 抽帧失败 | 本条不带视频摘要，继续走文本链路 |
| 回复里出现路径 / `sk-` / `Bearer` / 占位符 | 整条 `blocked`，不截断后发 |
| 外来文字命中注入规则 | 强制进待审，绝不自动发 |
| 待审草稿超过 `approvalTtlHours` | 批准时直接作废 |
| 重启 | `seen.json` 去重账本保证不重复处理、不重复发 |

详见仓库根 `docs/RULES.md`、`docs/PROMPT-INJECTION.md`、`docs/TROUBLESHOOTING.md`。
