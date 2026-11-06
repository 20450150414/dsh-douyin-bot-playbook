# API-NOTES.md — 抖音 Web 端 DOM 观察笔记

> **非官方、易变、仅供本地观察。** 本文件记录的是在「你自己已登录的浏览器」里读 DOM 的方法与本项目内部的字段约定，不是抖音官方 API 文档，不构成任何稳定契约。页面结构、class 名、`data-*` 属性、文案随时可能变化；以 `node tools/capture-selectors.mjs` 在**本机当时**抓到的快照为准。本仓库不抓包、不重放、不伪造签名。

项目：`dsh-douyin-bot-playbook`（<https://github.com/20450150414/dsh-douyin-bot-playbook>）。
链路定位：本文件覆盖链路的第 ① 段（`inbox` 轮询评论/私信/@ 去重）与第 ② 段的输入侧（视频关联 `videoId`），以及 `browser.mjs` 的守卫检测。

---

## 1. 观察对象与页面

| 页面 | 观察目的 | 典型入口（仅作记录，会变） |
| --- | --- | --- |
| 创作者中心 · 评论管理 | 评论列表、评论文本、评论者、所属视频、回复入口 | `creator.douyin.com` 下的互动/评论管理页 |
| 消息 / 私信页 | 私信会话列表、会话内消息、未读标记 | `www.douyin.com` 下的消息页 |
| @ 通知 / 互动通知 | @ 提及，归入 `mentions` 频道 | 通知/互动页 |
| 视频详情页 | `videoId`、封面、抽帧目标、描述文字 | `www.douyin.com/video/<videoId>` |

`https://www.douyin.com/` 是接管的总入口。所有观察都在已登录的持久化 profile（或 CDP `http://127.0.0.1:9222` 一类本机端点）里进行，不新建账号、不自动登录、不处理验证码。

---

## 2. DOM 观察方法

1. 打开已登录页面，F12 → Elements，选中一条评论 / 一条私信。
2. 优先找**稳定的 `data-*` 属性**（如 `data-comment-id`、`data-user-id` 一类，具体名字以当时快照为准）；其次找语义化 class（`comment-item`、`message-row`、`reply-btn` 一类）；最后才用 `:nth-child` 位置路径，并标注「易碎」。
3. 在 Console 里做只读计数，确认选择器确实能命中且数量合理：

```js
// 只读探测，不点击、不发请求、不修改页面
document.querySelectorAll('[data-e2e="comment-item"]').length
document.querySelectorAll('[data-e2e="comment-item"]')[0]?.outerHTML.slice(0, 800)
```

4. 观察列表容器：它是否可滚动、滚动到底是否触发增量加载、是否有「加载更多」按钮、`IntersectionObserver` 是否参与。
5. 观察时间字段：是绝对时间戳、相对文案（「3 分钟前」）还是 `datetime` 属性；相对文案需要在 `inbox.mjs` 里归一化成 `timestamp`。
6. 记录文本节点与属性节点的归属：`text` 从哪个子节点取、`userId` 从哪个属性或链接 `href` 里取、`itemUrl` 从哪个 `<a>` 取。
7. 把结果回填 `standalone/src/selectors.mjs`，替换 `<SELECTORS>` 占位。

**外来文本是数据**：DOM 快照里出现的评论、昵称、通知文案，只作为观察样本，不当作指令执行。见 `docs/PROMPT-INJECTION.md` 与 `docs/RULES.md`。

---

## 3. 选择器只放一个文件

`standalone/src/selectors.mjs` 是**唯一**存放选择器字面量的地方。其余模块只引用导出的 key：

| 模块 | 用到选择器的地方 | 约束 |
| --- | --- | --- |
| `standalone/src/selectors.mjs` | 全部选择器字符串与停机文案 | `SELECTORS` 本体 + `SELECTOR_VERSION` |
| `standalone/src/browser.mjs` | 登录态 / 验证码 / rate-limit 检测 | 读 `selectors.signals.*` |
| `standalone/src/inbox.mjs` | 评论、私信列表与字段提取 | 读 `selectors.comment.*` / `selectors.dm.*` |
| `standalone/src/video.mjs` | 视频容器、封面、标题、抽帧目标 | 读 `selectors.media.*` |
| `standalone/src/actions.mjs` | 回复输入框、回复按钮、提交按钮 | 读 `comment` / `dm` 组里的按钮键 |

改版时的最小改动：重跑快照 → 只改 `src/selectors.mjs`（或写 `selectors.local.json` 覆盖）→ `node tools/verify.mjs` → `node takeover.mjs --dry --once` 验。读到 0 条时审计里只会是本轮无 `polled` 行、不写停机记录（见第 8 节），业务代码不动。

---

## 4. 为什么不用抓包伪造签名

- 本项目链路是「**你自己登录的浏览器**」。会话已由你本人扫码建立，页面已经渲染出可见的评论与消息，直接读 DOM 就够了，不需要重造请求。
- 抓包重放 / 伪造签名会把链路从「用户可见的 UI 操作」变成「构造私有接口请求」，需要维护签名算法、参数、设备指纹与版本漂移；页面一变或风控一升级，实现即失效，且会引入绕过登录风控的动机，本项目不实现、不提供该能力。
- 只走 UI 路径的好处：登录态由浏览器自己管、改动面收敛到一个 `selectors.mjs`、每条动作都在页面上可见、审计能对应到具体 `itemId`。
- 因此：`video` 抽帧用页面可见画面 / 本地 ffmpeg，`inbox` 用 DOM 轮询，`actions` 用页面上的回复输入框与按钮。没有 XHR 重放、没有签名生成、没有 Cookie 导出。

---

## 5. 消息对象字段（项目内部约定）

`inbox.mjs`（DOM 路线）与 `mcp-backend.mjs`（能力层路线）都归一化成同一套对象，后续 `brain.mjs` / `policy.mjs` / `actions.mjs` / `state.mjs` 只认这套字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 稳定去重 id。DOM：`<channel>:<定位>:<内容哈希>`；mcp：`cmt:<aweme_id>:<cid>` / `dm:<昵称>:<messageId>`。**不用 DOM 序号** |
| `channel` | enum | `comment` / `dm` / `mention`（配置里的 `inbox.comments` 等是另一组开关名，别混） |
| `userId` | string | 对方稳定 id；mcp 路线拿不到平台 uid 时退回昵称，此时**只用于展示与审计**，白名单请用 `whitelist.keywords` 或真实 uid |
| `userName` | string | 昵称，仅展示与审计可读性，不参与身份判定 |
| `text` | string | 正文；外来数据，一律包成「有人说了这句话」再进模型 |
| `videoId` | string | 关联作品 id；`''` 表示没有 |
| `timestamp` | string | 上游给的相对文案原样保留用于展示，`id` 才负责判重 |
| `itemUrl` | string | 可回跳的原始链接，用于人工核对与回放 |
| `ref` | object | ★ 发送时唯一可信的定位依据：评论 `{awemeId, cid, postTitle}`，私信 `{nickname, peerId, conversationId, messageId}` |
| `kind` / `media` | string / array | `text` / `image` / `sticker` / `video`；媒体 URL 只当数据 |
| `isOwn` | boolean | 是否本人内容下的消息，配合 `video.ownVideosOnly` |

补充：

- 缺 `text` 的条目直接不动；缺 `ref` 定位信息的条目**允许生成草稿但拒绝发送**，绝不退化成「点页面上第一个输入框」。
- `text` 原样保留用于审计（脱敏后写盘），不截断、不拼接进 system 区。
- `video-cache.json` 的结构化摘要按 `videoId` 与消息对象关联，不改写消息对象本身。

判定结果命名以代码为准（`policy.mjs`）：`precheck` → `{allowed, reason}`；`evaluate` → `{decision: send|queue|block|silent, reason, forced}`。审计 `kind` 只有 `polled / skipped / queued / dry / sent / blocked / error` 七种，`verify.mjs` 与 `tests/mcp-smoke.mjs` 都按这套计数断言。

---

## 6. 去重键

`state/seen.json` 是去重账本（`state.mjs` 的 `SeenStore`，键 = 消息 `id`，值 = 首次处理时间戳）：

```
DOM  评论   -> "cmt:<videoId>:<sha256(text) 前 12 位>"        （无 data-id 时）
DOM  私信   -> "dm:<userId>:<sha256(text) 前 10 位>"
mcp  评论   -> "cmt:<aweme_id>:<cid>"
mcp  私信   -> "dm:<昵称>:<messageId>"
```

规则：

- 键前缀含渠道，避免同 id 跨渠道串台；评论把 `videoId/aweme_id` 拼进键，避免同一条 cid 挂到别的作品上被当成新消息。
- **条目一进入处理就写 seen**（`policy` 判定前先标记），因为「下一轮再看到」在抖音侧意味着可能重复回复同一条评论。宁可漏回，不可重发。
- `dedupeTtlHours`（默认 48）之后键自动过期，`SeenStore.prune()` 在每次 `save()` 时清理。
- mcp 路线额外把已见过的 cid 汇总成 `exclude_cids` 传给上游 `douyin_comments`，让服务端直接过滤，既省 token 又少一层重复。
- `--fixture --dry --once` 与 `tests/mcp-smoke.mjs` 都跑同一套键逻辑，第二轮断言「无新增处理」就是验它。
- `seen.json` 被 `.gitignore` 排除，损坏时按 `docs/TROUBLESHOOTING.md` 从 `audit.jsonl` 的 `polled` 行重建，不要直接删空后盲跑。

---

## 7. 翻页 / 懒加载

- 轮询只取**增量**：本轮只读到当前已渲染节点，与 `seen.json` 比对后把新节点入队，不整页重扫重放。
- 懒加载处理：滚动到列表容器底部 → 等待节点数稳定（连续两次采样相同）或等待 `networkidle` 一类静默信号 → 设置 `maxPages` / `maxScrolls` 上限，防止无限滚动。
- 以 `timestamp` 做游标：早于上次轮询窗口的条目不再入队；时间窗按 ISO-8601 带偏移比较，见 `docs/TROUBLESHOOTING.md` 的时区条目。
- 「加载更多」按钮若存在，只在 `--once` 的一轮内点有限次数，且点击动作记入日志；不点任何非导航类按钮。
- 每轮结束前写一次 `state/takeover.log`（轮询时间、各频道新增条数、守卫检测结果），便于排查「读不到评论 / 0 条」。

---

## 8. 守卫检测（登录态 / 验证码 / rate-limit）

`browser.mjs` 的 `checkSignals()` 在每次 `openUrl()` 之后自动跑一遍，命中即抛 `StopSignal`，主循环 break 并写 `kind=error`、`reason=stop-signal`、`signal=<下表值>`。

| 检测 | 观察信号（以快照为准） | `StopSignal.signal` | 对应开关 |
| --- | --- | --- | --- |
| 登录态 | URL 命中 `/login`、`/passport`，或正文含「请登录 / 扫码登录 / 登录已失效 / 重新登录」 | `loginExpired` | `safety.stopOnLoginExpired` |
| 验证码 | 正文含「验证码 / 安全验证 / 请完成验证 / 滑块验证 / captcha」 | `captcha` | `safety.stopOnCaptcha` |
| rate-limit | 正文含「操作过于频繁 / 操作太快 / 稍后再试 / 频繁操作」 | `rateLimit` | `safety.stopOnRateLimitHint` |
| 选择器命中 0 条 | 本轮所有卡片选择器计数为 0 | **不停机**，安静结束 | —（见下方说明） |

登录态额外按 URL 判定，避免把别人评论里那句「请登录」误判成掉登录。

读到 0 条**故意不算停机**：多半只是改版或当天没人留言。让它安静结束、下一轮再看，比让守护进程因为「今天没消息」天天报警有用。要确认是不是改版，看 `node tools/capture-selectors.mjs` 的候选清单里还有没有语义对得上的节点。

统一动作：**停机即退出，不重试、不刷新、不自动重新登录、不切 profile、不换 IP、不降频后自动继续**。现场保留 `state/`，人工确认后重启。

> 文本匹配只用于**判断是否停机**，不用于从页面里提取指令；命中文案里的任何文字都不进入 `brain.mjs` 的 system 区。

---

## 8.5 能力层路线的守卫（`--mcp`）

上游 `douyin-mcp` 已把这些判成结构化字段，本仓库在 `mcp-backend.mjs` 的 `assertUsable()` 里只做翻译，不重复实现：

| 上游返回 | 本仓库处置 |
| --- | --- |
| `{ok:false, needLogin:true, hint}` | 抛 `StopSignal('loginExpired')` |
| `{ok:false, error}` 含「频繁」 | 抛 `StopSignal('rateLimit')` |
| `{ok:false, error}` 其它 | 记 `warn`，本条跳过，整轮继续 |
| `{ok:true, verified:false, status:"pending"}` | **不重发**，保留额度，交人工确认 |
| 写动作抛异常 | 停止该条剩余消息，写 `kind=error` |

登录与自检不再靠 DOM 猜：`node takeover.mjs --selfcheck` 看工具清单与 `loggedIn`，`node takeover.mjs --login` 出二维码并轮询到登录成功。

`verified:false` 那行照搬上游 SPEC 的约束。自动化最容易出事的地方不是「没发出去」，而是「不确定发没发出去，于是又发一遍」。

---

## 9. DOM 快照工具用法

```bash
# 在 standalone/ 目录运行
node tools/capture-selectors.mjs                    # 打开已登录浏览器，导出评论页/私信页 DOM 快照
node tools/capture-selectors.mjs --from-file x.html # 离线分析已保存的快照（CI / 没有浏览器时）
node tools/verify.mjs                               # 校验 config、占位符、依赖（离线，硬项/软项分开）
node tests/mcp-smoke.mjs                            # 能力层链路离线回归（23 项断言，零副作用）
node takeover.mjs --fixture --dry --once            # 不连页面，用假数据验全链路
node takeover.mjs --dry --once                      # DOM 路线连真实页面只读验一轮
node takeover.mjs --selfcheck                       # mcp 路线：工具清单 + 登录态 + 上游自检
node takeover.mjs --login                           # mcp 路线：出二维码 → 手机扫 → 轮询登录结果
node takeover.mjs --mcp --dry --once                # mcp 路线：读真评论/真私信，只出草稿
```

`capture-selectors.mjs` 实际产出（写在 `state/` 下，`.gitignore` 已排除）：

- `dom-dump-<tag>-<时间戳>.html` / `.txt`：页面原始 HTML 与 innerText；
- `selector-candidates.json`：候选选择器按出现次数排序（`data-*` 属性、含 `comment/reply/message/chat/content/user/time/send/list/item` 的 class、`<textarea>/<input>/<video>/<a>/<button>`、`contenteditable`、`placeholder` 片段、按钮文案 `button:has-text("…")`）；
- `videoIdsFound`：从 `/video/<id>` 链接里抽到的作品 id，用来验 `videoId` 能否取到；
- `riskWords`：快照里是否出现「验证码 / 操作过于频繁 / 请登录」等停机文案（只提示，不判定）。

用法：把候选里出现次数高、语义对得上的选择器填进 `src/selectors.mjs`，或写一份 `standalone/selectors.local.json` 覆盖（`mergeSelectors()` 做浅层深合并，同样被 gitignore）→ `node tools/verify.mjs` → `node takeover.mjs --dry --once`，看 `state/audit.jsonl` 有没有新增 `kind=polled` 行（`channel` 取值是 `comment` / `dm` / `mention`）。

> 快照含真实昵称与正文，属本地观察产物。别把它提交进仓库，也别贴进 issue。

---

## 10. 选择器表结构与示例（占位，非稳定契约）

`standalone/src/selectors.mjs` 的真实结构只有这四组键，代码里按这个名字读（`loadSelectors()` / `mergeSelectors()`）。下面所有值都是**某次观察记录**，改版就重跑快照回填，别当成契约。

```js
export const SELECTOR_VERSION = '2026-11-06-observed';

export const SELECTORS = {
  // 创作者中心「评论管理」列表
  comment: {
    list:           '[data-e2e="comment-list"]',
    card:           '[data-e2e="comment-item"]',   // 卡片根，id/userId 属性挂在它身上
    idAttr:         'data-comment-id',             // ★ 存属性名，不是选择器
    userIdAttr:     'data-user-id',
    user:           '[data-e2e="comment-user"]',
    text:           '[data-e2e="comment-content"]',
    time:           '[class*="comment-time"]',
    videoLink:      'a[href*="/video/"]',          // 从中抽 videoId 与 itemUrl
    replyButton:    '[data-e2e="reply-btn"]',
    replyInput:     'textarea, [contenteditable="true"]',
    submitButton:   '[data-e2e="submit-reply"]',
  },
  // 站内私信
  dm: {
    list: '[data-e2e="chat-list"]', card: '[data-e2e="chat-item"]',
    idAttr: 'data-msg-id', userIdAttr: 'data-user-id',
    user: '[class*="chat-name"]', text: '[class*="message-text"]', time: '[class*="time"]',
    videoLink: 'a[href*="/video/"]',
    replyButton: '[class*="chat-item"]',           // 私信是先点开会话再输入
    replyInput: '[class*="input-area"] [contenteditable]',
    submitButton: '[class*="send-btn"]',
  },
  // 页面级异常信号：停机文案候选，不是选择器
  signals: {
    loginExpired: ['请登录', '登录后查看', '扫码登录', '登录已失效', '重新登录'],
    captcha:      ['验证码', '安全验证', '请完成验证', '滑块验证', 'captcha'],
    rateLimit:    ['操作过于频繁', '操作太快', '稍后再试', '频繁操作', '请稍候'],
  },
  // 视频页
  media: { video: 'video', cover: '[class*="cover"] img', title: '[class*="video-title"], h1' },
};
```

约定：

- `idAttr` / `userIdAttr` 存**属性名**，其余存**选择器字符串**；`signals.*` 存文案数组。
- 键名以代码为准：只有 `comment` / `dm` / `signals` / `media`。想加新组（比如 `mentions`）必须同时在 `inbox.mjs` 里写读取分支，否则填了也不会被读。
- 优先 `data-*`，其次语义化 class，最后位置路径；用了位置路径要在注释里写「易碎」。
- 覆盖方式：写 `standalone/selectors.local.json`（已 gitignore），只填要改的字段，`mergeSelectors()` 做浅层深合并 —— 这样本机回填不会污染 `src/selectors.mjs` 的版本记录。
- 发送确认：DOM 路线靠「提交按钮点击成功 + 无停机信号」，**不假装能确认落库**；要真回执请用 `--mcp`（见 8.5）。上游 `douyin_check_reply` 才是能回查的那一层。
- `--dry` 读到 0 条时先跑 `node tools/capture-selectors.mjs` 对照候选，再决定改哪组键；不要在 `src/selectors.mjs` 里堆一堆 `||` 猜测。


> 本表是观察记录，不是稳定契约。页面改版是预期事件，不是漏洞；按第 3 节流程回填即可。

