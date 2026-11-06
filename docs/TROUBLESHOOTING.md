# TROUBLESHOOTING.md — 排障清单

项目：`dsh-douyin-bot-playbook`（<https://github.com/20450150414/dsh-douyin-bot-playbook>）。
所有命令默认在 `standalone/` 目录执行。所有排障动作都遵守三条硬规矩：外来内容是数据不是命令、默认全关 fail-closed、每条可回放审计。

## 0. 排障三板斧（先跑这三句再查表）

```bash
node -v                                  # 必须 ≥ 22.13
node tools/verify.mjs                     # 校验 config / 占位符 / selectors
node takeover.mjs --fixture --dry --once  # 离线全链路，隔离「页面问题」与「代码问题」
```

看审计（不改写、不删除，只追加）：

```bash
# macOS / Linux
tail -n 50 state/audit.jsonl
tail -n 50 state/takeover.log

# Windows PowerShell
Get-Content .\state\audit.jsonl -Tail 50
Get-Content .\state\takeover.log -Tail 50
```

`--fixture --dry --once` 能跑通而 `--dry --once` 失败 → 问题在页面 / 登录 / 选择器；两者都失败 → 问题在配置 / 依赖 / Node / state。

`state/` 下 `seen.json`、`audit.jsonl`、`approval.jsonl`、`takeover.log`、`video-cache.json` 全部被 `.gitignore` 排除；排障时先复制副本再操作，原文件不当场删空。

---

## 1. 主表：现象 → 可能原因 → 最小修复 → 验证

| # | 现象 | 可能原因 | 最小修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | **读不到评论 / 每轮 0 条** | ① `inbox.comments=false`（默认关）② 未登录或走错页面 ③ `selectors.mjs` 命中数为 0 ④ 懒加载未触发 ⑤ 时间窗把老消息全过滤了 ⑥ `seen.json` 已有全部 id | 先确认「0 条」是否是预期：默认全关下本来就不采。需要观察时只把 `inbox.comments` 打开、保持 `reply.enabled=false` / `reply.dryRun=true`；确认已登录且落在创作者中心评论管理页；`node tools/capture-selectors.mjs` 重抓快照回填 `selectors.mjs`；滚动容器到底并等节点数稳定；检查 `inbox` 时间窗与 `timestamp` 归一化；`tail state/audit.jsonl` 看是否有 `kind: comment` 行 | `node takeover.mjs --dry --once` 后 `state/takeover.log` 里各频道新增条数 > 0，且 `state/audit.jsonl` 新增 `kind: comment` 行、`decision` 为 `deny`/`dry` |
| 2 | **页面改版，选择器全失效** | DOM class / `data-*` 变了；上一轮有数据、本轮所有列表选择器命中数归零 | 不改业务代码：重跑 `node tools/capture-selectors.mjs` → 只改 `standalone/src/selectors.mjs` 里 `<SELECTORS>` → `node tools/verify.mjs` 确认无残留 → `node takeover.mjs --dry --once`。停机记录写 `reason: selector_broken` | 同上能读出新条目；`selectors.mjs` 无 `<SELECTORS>` 残留；优先级保持 `data-*` > 语义化 class > `:nth-child` |
| 3 | **登录态掉了** | ① 持久化 profile 被另一个 Chromium 抢锁 ② Cookie 自然过期 ③ 手动清了浏览器数据 ④ CDP 端点指向了另一个浏览器实例 | 立刻停机（`reason: login_required`）。关掉所有指向同一 `.pw-profile` 的浏览器进程；核对 `config.json` 的 `browser` 里 profile 路径 / CDP 端点；重新跑一次 `node takeover.mjs --dry --once` 人工扫码；不要自动重登、不换号、不导入 Cookie | `node takeover.mjs --dry --once` 不再出现登录弹窗，页面能读到头像节点与评论列表；`state/audit.jsonl` 无新增 `shutdown` 行 |
| 4 | **验证码 / 滑块 / 安全验证** | 页面出现 `guards.captcha` 命中 | 立刻停机（`reason: captcha_detected`），**不重试、不换号、不绕过**。人工在浏览器里完成验证，确认页面恢复正常后再启动。本项目不提供任何验证码处理能力 | 人工确认页面无验证容器；重启后 `state/takeover.log` 守卫检测结果为正常 |
| 5 | **「操作过于频繁」/「请稍后再试」** | `guards.rateLimitText` 命中 toast / 弹窗 | 立刻停机（`reason: rate_limited`），不自动降频续跑、不换 IP、不换号。等待自然恢复，人工核对 `reply` 频率配置并调低，再启动 | 重启后连续两轮无 rate-limit 文案；`state/audit.jsonl` 里停机行与恢复后的首行之间无发送记录 |
| 6 | **模型 401 / 鉴权失败** | `DOUYIN_LLM_API_KEY` 未设、过期、或把占位符 `[LLM_API_KEY]` 直接当密钥用了；`llm.baseUrl` 与 key 不匹配 | 设置环境变量（macOS/Linux `export DOUYIN_LLM_API_KEY="..."`；Windows PowerShell `$env:DOUYIN_LLM_API_KEY="..."`），或改写 `config.json` 的 `llm` 分组；确认 `llm.mock=false` 时走真实模型；临时用 `--fixture` + `llm.mock=true` 隔离验证其余链路。连续失败按 `docs/RULES.md` 停机，草稿丢弃、该批 `hold` | `node takeover.mjs --fixture --dry --once` 退出码 0；真实一轮 `--dry --once` 里 `reason` 不再是 `llm_auth_failed` |
| 7 | **模型超时 / 无响应** | 网络不通、模型端点慢、视觉请求体过大、`llm.timeout` 太小、并发过高 | 先用 `curl -I <llm.baseUrl>` 确认端点可达；调大 `llm.timeout`；`video.enabled=false` 缩小请求体；降低轮询并发；保持 `reply.dryRun=true` 观察。超时不产生发送，审计写 `hold` | `--dry --once` 在超时窗口内完成，审计每行有 `reason`，无半截草稿进入 `actions` |
| 8 | **模型返回乱码 / 非预期格式** | 返回非 UTF-8、`response_format` 与模型不兼容、模型把外来注入文本当指令回显、温度过高 | 在 `brain.mjs` 输出侧做 UTF-8 解码与结构化解析校验；解析失败的草稿直接 `hold` + `reason: parse_failed`，不发送；确认 `brain` 的 system 区只含人格卡与固定规则、外来文本只在 data 消息里（见 `docs/PROMPT-INJECTION.md`）；用 `--fixture` 里的 C01–C12 注入用例回归 | `node takeover.mjs --fixture --dry --once` 后 `audit.jsonl` 里注入用例全部 `hold`/`deny`，无一条 `allow`；无乱码进入 `text` |
| 9 | **视觉模型不支持图片** | 选了纯文本模型、图片编码方式不对、`video.enabled=true` 但 `llm` 未配视觉端点 | 换成 OpenAI 兼容的**文本 + 视觉**模型；或先设 `video.enabled=false`、用 `standalone/fixtures/video-summary-sample.json` 的假摘要跑全链路；`llm` 分组里文本与视觉端点分别确认 | `video.enabled=false` 时全链路通；开启视觉后 `--dry --once` 能为带 `videoId` 的消息生成结构化摘要 |
| 10 | **ffmpeg 找不到** | 未安装、不在 PATH、Windows 装完没重开终端、PATH 里是另一个版本 | Windows `winget install Gyan.FFmpeg` 或 `choco install ffmpeg -y`，`where ffmpeg`；macOS `brew install ffmpeg`；Linux `sudo apt install -y ffmpeg`；必要时在 `config.json` 的 `video` 分组填 ffmpeg 绝对路径。`video.enabled=false` 时不是必需依赖 | `where ffmpeg` / `which ffmpeg` 有输出；`node tools/verify.mjs` 在视频开启时不再报缺失 |
| 11 | **抽帧超时 / 抽帧失败** | 视频长、帧率/分辨率过高、ffmpeg 卡在无效流、`video` 超时太小、磁盘满 | 降低抽帧帧数与分辨率、调大 `video.timeout`、限制单次抽帧时长；保留 `state/video-cache.json` 缓存按 `videoId` 复用；抽帧失败时该条走「无摘要」分支并写 `reason: video_frame_timeout`，不阻塞 `inbox`，也不因无摘要就放行发送 | `--dry --once` 里该条有审计行且 `decision` 仍为 `deny`/`dry`；`video-cache.json` 命中缓存时不再重复抽帧 |
| 12 | **回复没发出去** | 默认全关（`reply.enabled=false` / `reply.dryRun=true` / `reply.requireHumanApproval=true` / 空白名单 + `allowAllWhenEmpty:false`）；`policy` 给了 `deny`/`hold`；`actions.sentMarker` 没确认 | 这是**预期行为**先确认：`grep` 审计里该 `itemId` 的 `reason`。确需上线时按 `docs/setup-manual.md` 的顺序逐项打开，白名单只放自己小号；用 `--pending` 看、`--approve <id>` 逐条放行；检查 `selectors.actions.*` 的 `replyButton` / `replyInput` / `submitButton` / `sentMarker` | 审计里该条 `decision` 从 `dry`/`deny` 变为 `allow` 且有 `human_approved`；页面上可见回复；`seen.json` 在 `sentMarker` 确认后才新增 |
| 13 | **待审队列不生效（`--pending` 空 / 放行无效）** | `reply.requireHumanApproval=false`；`reply.enabled=false` 导致草稿根本没生成；`--fixture`/`--dry` 下不产生真实发送；`approval.jsonl` 权限或路径错；条目已过 `pendingTtl` | 确认 `reply.requireHumanApproval=true` 且 `reply.enabled=true`（按上线顺序）；`node takeover.mjs --pending` 与 `state/approval.jsonl` 对照；`--approve <id>` 一次只放一条、id 取自 `--pending` 输出；过期待审作废是设计行为，不自动补发 | `--pending` 列出条目 → `--approve <id>` 后 `approval.jsonl` 新增一行且 `audit.jsonl` 对应条目 `reason: human_approved`；`config.json` 未被改动 |
| 14 | **重复回复** | `seen.json` 未写（动作未确认）、`actions.sentMarker` 选择器失效、`id` 取了 DOM 序号导致每次变、去重键缺 `videoId`/`channel` | 按 `docs/API-NOTES.md` 修去重键：评论 `comments:videoId:id`、私信 `directMessages:userId:id`；`id` 必须从 `data-*` 属性或链接参数取，不用序号；只有 `sentMarker` 确认完成才写 `seen.json`；被 `deny`/`hold` 的条目**不**写 seen（会下轮重现，属正常） | 连续两轮 `--dry --once`，同一 `itemId` 只出现一次 `decision: allow`；`seen.json` 里键含 `channel` 与 `videoId` |
| 15 | **串台（A 的话回给 B）** | 上下文键没用 `channel + userId + itemId` 三元组；`userId` 取成了昵称；`brain` 的 system 区被外来文本污染；`itemId` 复用错位 | `policy.mjs` / `brain.mjs` 一律按三元组取上下文；`userId` 从 `selectors` 的属性取、不从昵称推断；确认 system 区是启动期常量（见 `docs/PROMPT-INJECTION.md`）；`userId` 解析不了时 `hold` + `reason: identity_unresolved`，不猜测归并 | 用两个不同 `userId` 的 fixture 消息跑 `--fixture --dry --once`，审计里 `userId` 与 `text` 一一对应；A 的草稿不出现在 B 的行里 |
| 16 | **频率闸误杀（正常消息被 `deny: rate_limit`）** | 时间窗/计数窗口设太小、把 `inbox` 轮询次数算进了发送次数、多频道共用一个计数器、跨时区时间比较错 | 频率闸只统计**已发送**动作，不统计轮询与 `deny`/`hold`；按 `channel` + `userId` 分桶计数；核对 `reply` 的窗口与上限单位（秒/分/小时）；时间统一按 ISO-8601 带偏移比较（见 #21） | `--fixture --dry --once` 里正常对照用例 C13 的 `reason` 不再是 `rate_limit`；窗口内多条消息只拦超阈值部分 |
| 17 | **控制台打不开（127.0.0.1:3210）** | `console.enabled=false`（默认关）、`DOUYIN_CONSOLE_TOKEN` 未设或填了占位符、端口被占、绑定到了别的地址、进程没在跑 | 按上线顺序最后才开：设 `console.enabled=true`，设 `DOUYIN_CONSOLE_TOKEN`（环境变量或 `config.json` 的 `console` 分组），重启挂机进程 `node takeover.mjs --dry`；确认只监听 `127.0.0.1:3210`；查端口占用（见 #18）。控制台**只读**，不提供发送按钮 | `curl -i http://127.0.0.1:3210/` 返回预期响应；带令牌能读 `state/`，页面无写入口 |
| 18 | **端口占用（3210 / 9222）** | 另一个进程监听了同端口；上次的 bot 或浏览器没退出；`skills-adapt/` 里 `<端口>` 占位符没替换 | Windows `netstat -ano \| findstr :3210` + `taskkill /PID <pid> /F`；macOS/Linux `lsof -i :3210` + `kill <pid>`；CDP 端口 `9222` 同理；`skills-adapt/` 的 `<端口>` 与 `<用户目录>` 占位符先替换成本机值再安装 | `netstat` / `lsof` 无冲突监听；`node takeover.mjs --dry` 正常起；`node tools/verify.mjs` 无占位符告警 |
| 19 | **`config` 占位符没换** | `config.json` 里残留 `[LLM_API_KEY]` / `[ASR_API_KEY]` / `[CONSOLE_TOKEN]` / `<SELECTORS>`；从模板复制后没填；`--config <path>` 指到了模板本身 | `node tools/verify.mjs` 会报残留；按 `config/FILL.md` 逐字段填；未启用 ASR / 控制台时对应占位符可留空但要在 `FILL.md` 口径内；`<SELECTORS>` 由 `node tools/capture-selectors.mjs` 回填 `src/selectors.mjs`；`--config` 明确指向 `standalone/config.json` | `node tools/verify.mjs` 零告警；`node takeover.mjs --once --config ./config.json` 退出码 0 |
| 20 | **Node 版本过低** | `node -v` < 22.13；`parseArgs` / `fetch` 不是 `function`；报 `SyntaxError: Unexpected token` / ESM 加载失败 | 按 `docs/setup-manual.md` 步骤 1 装 Node ≥ 22.13（Windows `winget install OpenJS.NodeJS.LTS`、macOS `brew install node@22`、Linux `fnm install 22`）；重开终端后重跑 `npm install`（原生模块可能需要重装） | `node -v` ≥ 22.13；`node -e "import('node:util').then(u=>console.log(typeof u.parseArgs))"` 输出 `function`；`node -e "console.log(typeof fetch)"` 输出 `function` |
| 21 | **本机路径泄漏被拦（`secret_pattern`）** | 模型草稿里带了 `C:\Users\...` / `/Users/...` / `/home/...`、密钥前缀、token 片段；`safety.secretPatterns` 默认全开 | 这是**预期拦截**，不要关 `safety.*`。修 `brain.mjs` 的提示与上下文：system 区不放本机路径、不把 `state/` 绝对路径塞给模型；`policy.mjs` 命中即丢弃草稿、`decision: hold`、`reason: secret_pattern`，审计里 `text` 脱敏后写入 | `--fixture --dry --once` 后审计里无完整本机路径与密钥值；`reason: secret_pattern` 的条目均为 `hold`，无 `allow` |
| 22 | **去重账本 `seen.json` 损坏** | 进程被强杀写了一半、手工编辑过、JSON 不合法、权限只读 | 停机（`reason: state_write_failed`），**先复制** `state/` 整个目录做备份；再从 `state/audit.jsonl` 按 `itemId` 重建 `seen.json`（只收 `decision: allow` / `dry` 且动作已确认的条目）；`node -e "JSON.parse(require('fs').readFileSync('state/seen.json','utf8'))"` 校验语法；不要直接删空后盲跑，否则会重复回复 | 校验通过；`node takeover.mjs --fixture --dry --once` 后连续两轮 `--dry --once` 无重复 `allow`；审计只追加、历史行未改动 |
| 23 | **时间窗 / 时区错乱** | `timestamp` 用了相对文案（「3 分钟前」）没归一化、混用本地时间与 UTC、ISO 字符串无偏移、跨日窗口算错、机器时区与浏览器时区不一致 | `inbox.mjs` 统一把 `timestamp` 归一化为带偏移的 ISO-8601（如 `2026-11-06T11:04:08+08:00`）；所有比较先转 UTC 毫秒；`reply` 时间窗、`pendingTtl`、`rate_limit` 窗口用同一套工具函数（`standalone/src/util.mjs`）；`state/audit.jsonl` 的 `ts` 也带偏移 | `state/audit.jsonl` 每行 `ts` 带 `+08:00` 一类偏移；跨日消息仍落在正确窗口；`--fixture` 里不同时区的样例不会全被时间窗过滤 |

---

## 2. 按「哪一段坏了」定位

| 症状集中在 | 优先查的模块 / 文件 | 隔离命令 |
| --- | --- | --- |
| 读不到消息 | `standalone/src/browser.mjs`、`inbox.mjs`、`selectors.mjs` | `node tools/capture-selectors.mjs` → `node takeover.mjs --dry --once` |
| 视频 / 摘要不对 | `standalone/src/video.mjs`、`fixtures/video-summary-sample.json`、`state/video-cache.json` | `video.enabled=false` + `node takeover.mjs --fixture --dry --once` |
| 草稿不对 / 被注入带偏 | `standalone/src/brain.mjs`、`docs/PROMPT-INJECTION.md` | `--fixture` 注入用例 C01–C12 回归 |
| 决策不对 / 该发没发 | `standalone/src/policy.mjs`、`config.json` 的 `safety` / `reply` | `node takeover.mjs --pending`、`grep allowlist_empty state/audit.jsonl` |
| 发送动作没落地 | `standalone/src/actions.mjs`、`selectors.actions.*` | `--approve <id>` 单条 + 看 `sentMarker` |
| 审计 / 去重 / 状态 | `standalone/src/state.mjs`、`state/*.json*` | `tail state/audit.jsonl`，比对 `itemId` |
| 控制台 | `standalone/src/console.mjs`、`console.enabled`、`DOUYIN_CONSOLE_TOKEN` | `curl -i http://127.0.0.1:3210/` |
| 配置 / 依赖 | `config.json`、`config/FILL.md`、`config/config.example.json` | `node tools/verify.mjs`、`node -v` |

---

## 3. 停机类问题统一处理顺序

出现登录失效、验证码、「操作过于频繁」（表 #3/#4/#5）时，按 `docs/RULES.md` 的停机条件表执行：

1. 立刻停进程，**不重试、不换号、不绕过**；`state/audit.jsonl` 应有一行 `kind: shutdown`、`decision: shutdown`、`reason: login_required` / `captcha_detected` / `rate_limited`。
2. 复制 `state/` 整个目录留现场（含 `seen.json`、`audit.jsonl`、`approval.jsonl`、`takeover.log`、`video-cache.json`），不清理、不覆盖。
3. 人工在浏览器里处理（重新扫码 / 完成验证 / 等待频率恢复），确认页面正常；需要时按 #2 重抓选择器。
4. 按上线顺序从 `node takeover.mjs --dry --once` 重新开始，仍保持 `reply.enabled=false` / `reply.dryRun=true` 观察至少一轮。
5. 从 `state/seen.json` 继续去重，**不补发**停机窗口内的消息；`--pending` 里过期待审条目作废即可。

---

## 4. 常用命令速查

```bash
# 在 standalone/ 目录
node -v
node tools/verify.mjs
node tools/capture-selectors.mjs
node takeover.mjs --fixture --dry --once      # 离线假数据全链路
node takeover.mjs --dry --once                # 真实页面只读一轮
node takeover.mjs --dry                       # 挂机（不发送）
node takeover.mjs --pending                   # 看待审
node takeover.mjs --approve <id>              # 逐条放行
node takeover.mjs --once --config ./config.json
```

```bash
# 环境变量覆盖（不覆盖开关与白名单）
# macOS / Linux
export DOUYIN_LLM_API_KEY="[LLM_API_KEY]"
export DOUYIN_ASR_API_KEY="[ASR_API_KEY]"
export DOUYIN_CONSOLE_TOKEN="[CONSOLE_TOKEN]"
# Windows PowerShell
$env:DOUYIN_LLM_API_KEY = "[LLM_API_KEY]"
$env:DOUYIN_ASR_API_KEY = "[ASR_API_KEY]"
$env:DOUYIN_CONSOLE_TOKEN = "[CONSOLE_TOKEN]"
```

```bash
# 审计 / 日志
tail -n 50 state/audit.jsonl                 # macOS / Linux
Get-Content .\state\audit.jsonl -Tail 50      # Windows PowerShell
# 端口
netstat -ano | findstr :3210                  # Windows
lsof -i :3210                                # macOS / Linux
```

**排障时不要做的事**：不改 `safety.*` 的默认值（`true`）、不把 `allowAllWhenEmpty` 改成 `true`、不批量 `approve all`、不用环境变量打开开关、不删空 `state/`、不删改 `audit.jsonl` 历史行、不在停机后自动重试或换号。
