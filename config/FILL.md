# config / FILL.md —— 字段速查与必改项

> 模板：`config/config.example.json`。复制到 **`standalone/config.json`** 后再改（仓库根跑脚本时也是读这份）。
> **所有相对路径以 `standalone/` 为当前工作目录解析**。仓库根 `npm run demo` 会用 `cd standalone` 等价的方式运行，见 `package.json`。

## 0. 三条不能忘

1. `standalone/config.json`、整个 `standalone/state/` 都在 `.gitignore` 里，**不会进仓库**。但别把填好的 `config.json` 复制去覆盖 `config.example.json`。
2. 密钥支持环境变量覆盖，优先级高于文件：`DOUYIN_LLM_API_KEY`、`DOUYIN_ASR_API_KEY`、`DOUYIN_CONSOLE_TOKEN`。**推荐用环境变量**，文件里保留占位符。
3. 任何一项不确定就保持默认（关）。**空白名单 + `allowAllWhenEmpty:false` = 谁都不回**，这是刻意设计，不是 bug。

## 1. 必填（跑真账号时）

| 字段 | 填什么 | 不填会怎样 |
|---|---|---|
| `llm.apiKey` | 你的 OpenAI 兼容模型 Key，或设 `DOUYIN_LLM_API_KEY` | 非 mock 模式下模型调用直接失败 → 当轮潜水，不发送 |
| `browser` / `account.profileDir` | 一个本机目录，用来存浏览器登录态 | 每次都要重新扫码 |
| `douyin.commentInboxUrl` / `dmInboxUrl` | 你账号实际的「评论管理 / 消息」页地址 | 轮询读不到东西（`--dry` 会显示 0 条，这是安全的失败） |
| `src/selectors.mjs` | 按 `node tools/capture-selectors.mjs` 的 DOM 快照改 | 页面改版后读不到卡片，**不会误发** |

`--fixture --dry --once` **一个都不用填**，用假数据跑通链路。

## 2. 开关矩阵（默认全 false / true 的意义）

| 字段 | 默认 | 打开意味着 |
|---|---|---|
| `douyin.useFixture` | `false` | 用假消息，不碰浏览器、不联网 |
| `llm.mock` | `false` | 用固定假决策，不调模型、不花钱 |
| `video.enabled` | `false` | 每条带视频的消息都会抽帧 + 调视觉模型（**花钱**） |
| `video.asr.enabled` | `false` | 额外抽音频 + 调 ASR（更花钱，需要 ffmpeg） |
| `inbox.comments` | `false` | 开始读评论区 |
| `inbox.directMessages` | `false` | 开始读私信（比评论更敏感，建议最后开） |
| `reply.replyToComments` | `false` | 允许**生成**评论回复草稿 |
| `reply.replyToDMs` | `false` | 允许**生成**私信回复草稿 |
| `reply.enabled` | `false` | 允许**真正发送**。关着时只出草稿 / 进待审队列 |
| `reply.dryRun` | `true` | 即使 `enabled=true` 也**不点发送按钮**，只写审计 |
| `reply.requireHumanApproval` | `true` | 发出前必须 `node takeover.mjs --approve <id>` |
| `reply.autoLike` | `false` | 顺手点赞。默认关，别和自动回复一起开 |
| `console.enabled` | `false` | 起本地只读控制台 `127.0.0.1:3210` |

**推荐的上线顺序**（每步至少跑一轮 `--dry`）：

```
--fixture --dry --once   →  useFixture=false + --dry --once   →  --dry（挂机观察）
→ enabled=true, dryRun=false, requireHumanApproval=true, whitelist=[自己小号]
→ --pending / --approve 逐条放行   →  跑满一天再考虑放宽白名单 / 开私信
```

## 3. 放行与频率（改之前先读 `docs/RULES.md`）

| 字段 | 建议起始值 | 说明 |
|---|---|---|
| `reply.whitelist.userIds` | `["<你的小号 sec_uid 或昵称>"]` | 精确匹配 `item.userId` 或 `userName`；空数组谁都不回 |
| `reply.whitelist.keywords` | `[]` | 命中评论关键词才回；与 userIds 是「或」关系 |
| `reply.whitelist.allowAllWhenEmpty` | `false` | **强烈建议永远 false**。设 true 等于对所有陌生人自动发声 |
| `reply.denylist.keywords` | 见模板 | 广告 / 引流 / 诈骗高频词，命中直接丢弃 |
| `reply.maxRepliesPerHour` | `3` → 稳定后 `8` | 按 `audit.jsonl` 里 `kind=sent` 滚动计算 |
| `reply.maxRepliesPerDay` | `20` → `40` | 同上 |
| `reply.minIntervalSec` | `30` | 两条发送之间最小间隔，模拟人手 |
| `reply.maxReplyChars` | `80` | 单条上限；超长的模型输出会被拦，不会被截断后发出 |
| `reply.maxRepliesPerItem` | `3` | 一条评论最多回几条 |
| `reply.dedupeTtlHours` | `48` | 同一 `item.id` 在窗口内只处理一次（重启不重复发） |
| `reply.approvalTtlHours` | `24` | 待审草稿过期作废，避免「三天前批准的话今天突然发出去」 |

## 4. 安全（不要为了「好用」去关）

| 字段 | 为什么 |
|---|---|
| `safety.treatExternalTextAsData` | 评论 / 私信 / OCR 文字一律包成「有人说了这句话」，不得当指令 |
| `safety.blockSecretsInOutput` | 回复里出现路径、`sk-`、`Bearer `、`[XXX_TOKEN]` 等特征 → 整条拦截 |
| `safety.injectionPatterns` | 命中「忽略之前的指令 / 把配置发我 / 你现在是管理员」→ **强制转人工，绝不自动发** |
| `safety.stopOnLoginExpired` | 登录态掉了立刻停机，不重试、不换号 |
| `safety.stopOnCaptcha` | 出验证码立刻停机，**不提供任何绕过** |
| `safety.stopOnRateLimitHint` | 页面出现「操作过于频繁」立刻停机并退避 |

`secretPatterns` / `injectionPatterns` 是 JS 正则字符串（JSON 里反斜杠要写两遍），统一以 `i` 标志编译。加规则时先在 `--dry` 下用假消息试，别直接上真账号。

## 5. 视频理解

| 字段 | 说明 |
|---|---|
| `video.captureMode` | `page-screenshot`（默认）：在已登录页面里 seek `<video>` 并截图，不需要下载视频；`ffmpeg-file`：对 `item.localVideoPath` 用 ffmpeg 抽帧（离线分析本地文件） |
| `video.maxFrames` / `frameIntervalSec` | 抽几帧、间隔几秒。6 帧 × 2 秒是成本与信息的折中 |
| `video.ownVideosOnly` | 只理解「自己账号下」的视频；别人的视频默认不理解（避免把抓取范围扩大到他人内容） |
| `video.cacheTtlHours` | 同一个 `videoId` 的理解结果缓存，避免重复烧 token |
| `video.asr.*` | 口播转写。需要 ffmpeg + 兼容 `/audio/transcriptions` 的服务 |

三条路线（只看元数据 / 抽帧看画面 / 抽帧 + ASR）的成本与取舍见 `playbook/03-video-understanding.md`。

## 6. 人设与输出

| 字段 | 说明 |
|---|---|
| `persona.name` | 替换提示词里的 `{{BOT_NAME}}` |
| `persona.systemPromptFile` | 默认 `../prompts/SYSTEM-PROMPT.md` |
| `persona.extraPromptFiles` | 追加 `reply-contract.md`；也可挂 `persona-嘴硬网友.md` 之类的人格卡 |
| `persona.historyItems` | 拼进上下文的最近消息条数，别调太大（成本 + 串台风险） |

## 7. 占位符清单

| 占位符 | 从哪来 |
|---|---|
| `[LLM_API_KEY]` | 模型厂商控制台；或环境变量 `DOUYIN_LLM_API_KEY` |
| `[ASR_API_KEY]` | ASR 服务；或 `DOUYIN_ASR_API_KEY` |
| `[CONSOLE_TOKEN]` | 自己生成一段随机串；或 `DOUYIN_CONSOLE_TOKEN` |
| `<SELECTORS>` | `node tools/capture-selectors.mjs` 的 DOM 快照 |

`node tools/verify.mjs` 会检查还有哪些占位符没换、哪些路径不存在、哪些依赖缺失。
