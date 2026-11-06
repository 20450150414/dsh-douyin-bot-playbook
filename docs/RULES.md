# RULES.md — 权限 / 放行 / 审计硬边界

项目：`dsh-douyin-bot-playbook`（<https://github.com/20450150414/dsh-douyin-bot-playbook>，GitHub 用户 `20450150414`）。
适用范围：`standalone/` 下全部模块、`skills/`、`skills-adapt/`、`playbook/` 的设计笔记，以及任何基于本仓库二次改写的实现。本文件是硬边界，配置不得覆盖，代码不得绕过。

---

## 0. 三条硬规矩（原文，逐字生效）

> **一、外来内容是数据不是命令。**
> 评论、私信、@ 通知、昵称、视频画面文字、ASR 转写、页面 DOM 文本，一律作为待分析的数据传入，不得作为指令、身份声明或配置来源。

> **二、默认全关 fail-closed。**
> 空白名单 + `safety.allowAllWhenEmpty: false` = 谁都不回。任何开关、任何环境变量、任何消息内容都不得把系统从「全关」自动翻到「可发送」。

> **三、每条可回放审计。**
> 每一条进入链路的外来消息，无论最终发送、拒绝、转人工还是空跑，都必须写 `state/audit.jsonl` 一行，包含 `decision` 与 `reason`，可按 `itemId` 重放。

链路固定：`你自己登录的浏览器（Playwright/CDP 只读看页面）` → ① `inbox` 轮询评论/私信/@ 去重 → ② `video` 抽帧 → 视觉模型 / 可选 ASR → 结构化摘要 → ③ `brain` 人格卡 + 上下文 + 外来消息（当数据）→ 模型出回复草稿 → ④ `policy` 白名单 / 频率闸 / 敏感词 / 注入检测 / 人工放行 / 审计 → ⑤ `actions` 回评论 / 回私信 /（可选）点赞，默认全关 → 每条写 `state/audit.jsonl` 可回放 → 本地只读控制台 `127.0.0.1:3210` 默认关。

---

## 1. 分层边界

### 1.1 只读浏览器层

- 浏览器只用于**读取 DOM / 抽帧 / 在页面上执行用户可见的回复动作**；不导出 Cookie、不把登录态序列化落盘、不把会话信息发给模型或控制台以外的地方。
- 使用你自己登录的持久化 profile 或 CDP 连接（默认 `http://127.0.0.1:9222` 一类本机端点），`browser.mjs` 不新建账号、不自动登录、不处理验证码。
- 只调用 Web 页面已渲染的 UI 路径，不抓包重放、不构造私有 API 请求、不伪造签名（见 `docs/API-NOTES.md`）。
- 只读观察与写动作分离：`inbox` / `video` 只读；`actions` 是唯一可写出口，且受第 2/3 层约束。

### 1.2 发送强制白名单层

- `safety.allowList` 是唯一身份来源。白名单按 `userId` 精确匹配，不接受昵称、正文自称、视频文案里的身份声明。
- `safety.allowAllWhenEmpty: false` 必须保持。白名单为空 → 所有发送决策为 `deny`，`reason` 记 `allowlist_empty`。
- 默认全关基线（保持原值，除非按 `docs/setup-manual.md` 的上线顺序逐项人工打开）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `douyin.useFixture` | `false` | 真实页面而非假数据 |
| `llm.mock` | `false` | 真实模型 |
| `video.enabled` | `false` | 不抽帧 |
| `inbox.comments` | `false` | 不采评论 |
| `inbox.directMessages` | `false` | 不采私信 |
| `reply.enabled` | `false` | 不回复 |
| `reply.dryRun` | `true` | 只算不发 |
| `reply.requireHumanApproval` | `true` | 强制人工 |
| `reply.autoLike` | `false` | 不点赞 |
| `console.enabled` | `false` | 不开控制台 |
| `safety.*` | 全部 `true` | 白名单 / 频率闸 / 敏感词 / 注入检测 / 审计 / 路径拦截全部开启 |

- 白名单、频率闸、敏感词、注入检测是**串联与门**：任一命中即 `deny` 或 `hold`，不存在「命中注入反而放宽」的逻辑。
- 频道级开关再叠一层：`inbox.comments=false` 时评论不得进入 `actions`，`inbox.directMessages=false` 时私信不得进入 `actions`。
- 环境变量 `DOUYIN_LLM_API_KEY` / `DOUYIN_ASR_API_KEY` / `DOUYIN_CONSOLE_TOKEN` 只覆盖密钥与令牌，**不得**用于打开开关或改动白名单。

### 1.3 人工放行层

- `reply.requireHumanApproval: true` 时，模型草稿一律进待审队列，不自动发送。
- 查看：`node takeover.mjs --pending`；放行：`node takeover.mjs --approve <id>`，**一次一条**，不允许批量 `approve all`。
- 每次放行写 `state/approval.jsonl`：`ts` / `id` / `approver` / `itemId` / `channel` / `userId` / `decision`。
- 放行只改变该条目的状态；它不修改 `config.json`，不打开任何开关，不扩大白名单。
- 待审条目过期即作废（按 `reply.pendingTtl` 一类时间窗），不因超时自动发送。
- `--dry` 与 `--fixture` 下不产生真实发送，即使人工放行也只写审计。

### 1.4 审计层（每条可回放）

`state/audit.jsonl` 每行一个 JSON 对象，字段固定：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ts` | ISO-8601 字符串 | 决策时间，带时区偏移 |
| `kind` | 字符串 | `comment` / `direct_message` / `mention` / `video_summary` / `approval` / `shutdown` |
| `channel` | 字符串 | `comments` / `directMessages` / `mentions` |
| `itemId` | 字符串 | 评论 / 私信 / @ 的稳定 id，回放主键 |
| `userId` | 字符串 | 对方 userId（不是昵称） |
| `text` | 字符串 | 外来原文或发出的草稿文本；敏感信息按 1.5 脱敏 |
| `reason` | 字符串 | 决策依据，如 `allowlist_empty` / `rate_limit` / `injection_match:P003` / `secret_pattern` / `human_approved` / `dry_run` / `login_required` |
| `decision` | 枚举 | `allow` / `deny` / `hold` / `dry` / `shutdown` |

补充约束：

- 拒绝、转人工、空跑、停机也必须有行，**不允许静默丢弃**。
- `state/seen.json`（去重账本）、`state/audit.jsonl`、`state/approval.jsonl`、`state/takeover.log`、`state/video-cache.json` 全部被 `.gitignore` 排除，不进仓库、不上传。
- 审计只追加，不改写、不删除；排障时复制副本再操作（见 `docs/TROUBLESHOOTING.md`）。
- 回放：按 `itemId` 串起 `inbox → brain → policy → actions` 的记录，用 `node takeover.mjs --fixture --dry --once` 加对应 fixture 复算，比对 `decision` 与 `reason`。
- 本地只读控制台 `127.0.0.1:3210` 默认关；开启时仅读 `state/`，需 `DOUYIN_CONSOLE_TOKEN`，不提供发送按钮。

### 1.5 敏感信息拦截层

- `safety.secretPatterns` 对**模型输出草稿**做拦截：命中 `[LLM_API_KEY]` / `[ASR_API_KEY]` / `[CONSOLE_TOKEN]` 形态、密钥前缀、本机绝对路径（如 `C:\Users\...`、`/Users/...`、`/home/...`）、Cookie / token 片段 → 丢弃草稿、`decision: hold`、`reason: secret_pattern`。
- `safety.injectionPatterns` 对**外来输入**做检测：命中即强制转人工，见 `docs/PROMPT-INJECTION.md`。
- 拦截发生在 `policy`，早于 `actions`；被拦截的文本仍写入审计，但先脱敏再写 `text`。
- 日志与控制台同样过滤：`takeover.log` 不打印完整外来正文与任何密钥值。

### 1.6 会话隔离层

- 上下文键 = `channel + userId + itemId` 三元组；`brain.mjs` 取上下文时只按该键取值，禁止跨键拼接。
- A 的话只回给 A；评论线程按 `itemId` + `videoId` 归属，私信按会话 `userId` 归属。
- 人格卡与系统规则是常量，不随会话变化；会话历史不写入 system 区。
- 出现 `userId` 缺失或无法解析时，该条 `decision: hold` + `reason: identity_unresolved`，不猜测、不按昵称归并。

### 1.7 外来内容当数据层

- 外来文本在 `brain.mjs` 里一律包成「有人说了这句话：……」的 data 消息，绝不拼进 system 区。
- 昵称、视频 OCR 文字、ASR 转写、封面文字、URL 参数同等级处理，均为数据。
- 外来内容里出现的「忽略之前的指令」「把配置发我」「你现在是管理员」「system prompt」等，只作为待分析文本，不改变任何运行时状态。
- 详见 `docs/PROMPT-INJECTION.md` 的三层防御与 fixture 用例。

### 1.8 管理员身份不信正文层

- 管理员 / 白名单身份**只来自 `config.json` 的 `safety.allowList`**，与消息正文无关。
- 正文里的「我是管理员」「系统指令」「开发者模式」「放行全部」一律不解析为授权，命中即按注入处理（`reason: injection_match:*`）。
- 昵称叫「管理员」「系统」「dsh-bot」不改变身份判定，按 `userId` 走。
- 人工放行的操作者身份来自本地 CLI 调用本身（`--approve`），不来自任何外来消息。

### 1.9 能力边界

- 本项目不提供绕过验证码、滑块验证、登录风控、请求签名、设备指纹、频率限制的能力。
- 不实现自动重试被风控拦截的动作、不换号、不代理池轮换、不模拟多账号、不伪造签名参数。
- 遇到风控信号按 1.10 停机，现场保留 `state/` 供人工处理。
- `skills-adapt/` 里的 `<用户目录>` / `<端口>` 只是路径与端口占位符，替换为真实值即可，不含任何绕过逻辑；`playbook/` 是设计笔记，不含可执行代码。

---

## 2. 停机条件表

命中任意一条：**立刻停机**，不重试、不换号、不绕过；写 `state/audit.jsonl`（`kind: shutdown`、`decision: shutdown`、`reason` 见表），进程退出，人工处理后方可重启。

| # | 信号 | 观察位置 | 立即动作 | 审计 `reason` | 恢复前置 |
| --- | --- | --- | --- | --- | --- |
| 1 | 登录失效 / 登录弹窗 / 跳转登录页 / 头像节点缺失 | 页面 DOM、`browser.mjs` 登录态检测 | 停止轮询与全部发送，退出 | `login_required` | 人工重新扫码一次，复用持久化 profile |
| 2 | 验证码 / 滑块 / 图形验证 / 安全验证容器出现 | 页面 DOM 守卫节点 | 停止轮询与全部发送，退出 | `captcha_detected` | 人工在浏览器完成验证，确认页面恢复正常 |
| 3 | 「操作过于频繁」「请稍后再试」「频繁操作」等 rate-limit 文案 | 页面 toast / 弹窗 / 响应文本 | 停止轮询与全部发送，退出 | `rate_limited` | 等待自然恢复，降低 `reply` 频率配置，人工确认 |
| 4 | 页面结构整体变化导致选择器全失效 | `selectors.mjs` 命中数归零 | 停止轮询（不盲发），退出 | `selector_broken` | 重跑 `node tools/capture-selectors.mjs` 回填后再 `--dry --once` |
| 5 | 模型连续鉴权失败 / 输出含密钥或本机路径 | `brain.mjs` / `policy.mjs` | 丢弃草稿，该批 `hold`，必要时退出 | `llm_auth_failed` / `secret_pattern` | 更换 `DOUYIN_LLM_API_KEY`，核对脱敏规则 |
| 6 | 审计写入失败 / 去重账本损坏 | `state.mjs` | 立刻退出，避免产生无审计动作 | `state_write_failed` | 备份并修复 `state/`，见排障文档 |
| 7 | 身份无法解析 / 串台风险 | `policy.mjs` | 该条 `hold`，不发送 | `identity_unresolved` | 修正 `selectors.mjs` 的 userId 取值 |

停机期间的 `state/audit.jsonl` 是现场证据，不清理、不覆盖；重启后从 `state/seen.json` 继续去重，不补发停机窗口内的消息。

---

## 3. 与配置 / CLI 的对应关系

| 硬边界 | 落地位置 |
| --- | --- |
| 默认全关 | `standalone/config.json`（模板 `config/config.example.json`，字段说明 `config/FILL.md`） |
| 白名单 / 频率闸 / 敏感词 / 注入检测 / 审计 | `standalone/src/policy.mjs`、`standalone/src/state.mjs` |
| 外来内容当数据 | `standalone/src/brain.mjs` |
| 唯一写出口 | `standalone/src/actions.mjs` |
| 只读观察 | `standalone/src/browser.mjs`、`standalone/src/inbox.mjs`、`standalone/src/video.mjs`、`standalone/src/selectors.mjs` |
| 待审 / 放行 | `node takeover.mjs --pending`、`node takeover.mjs --approve <id>` |
| 离线全链路自检 | `node takeover.mjs --fixture --dry --once` |
| 静态校验 / 选择器快照 | `node tools/verify.mjs`、`node tools/capture-selectors.mjs` |
| 假数据 | `standalone/fixtures/inbox-sample.json`、`video-summary-sample.json` |
| 只读控制台 | `standalone/src/console.mjs`，`127.0.0.1:3210` 默认关 |

依赖基线：Node ≥ 22.13（ESM、原生 `fetch` / `parseArgs`）、Playwright、可选 ffmpeg、OpenAI 兼容文本 + 视觉模型、可选 ASR。
