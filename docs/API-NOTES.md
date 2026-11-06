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
| `standalone/src/browser.mjs` | 登录态 / 验证码 / rate-limit 守卫节点 | 只引用 `selectors.guards.*` |
| `standalone/src/inbox.mjs` | 评论、私信、@ 列表与字段提取 | 只引用 `selectors.inbox.*` / `selectors.message.*` |
| `standalone/src/video.mjs` | 视频容器、封面、描述、抽帧目标 | 只引用 `selectors.video.*` |
| `standalone/src/actions.mjs` | 回复输入框、回复按钮、提交按钮 | 只引用 `selectors.actions.*` |

改版时的最小改动：重跑快照 → 只改 `src/selectors.mjs` → `node tools/verify.mjs` → `node takeover.mjs --dry --once` 验 → 在 `state/audit.jsonl` 留一条 `reason: selector_broken` 的停机记录后恢复。业务代码不动。

---

## 4. 为什么不用抓包伪造签名

- 本项目链路是「**你自己登录的浏览器**」。会话已由你本人扫码建立，页面已经渲染出可见的评论与消息，直接读 DOM 就够了，不需要重造请求。
- 抓包重放 / 伪造签名会把链路从「用户可见的 UI 操作」变成「构造私有接口请求」，需要维护签名算法、参数、设备指纹与版本漂移；页面一变或风控一升级，实现即失效，且会引入绕过登录风控的动机，本项目不实现、不提供该能力。
- 只走 UI 路径的好处：登录态由浏览器自己管、改动面收敛到一个 `selectors.mjs`、每条动作都在页面上可见、审计能对应到具体 `itemId`。
- 因此：`video` 抽帧用页面可见画面 / 本地 ffmpeg，`inbox` 用 DOM 轮询，`actions` 用页面上的回复输入框与按钮。没有 XHR 重放、没有签名生成、没有 Cookie 导出。

---

## 5. 消息对象字段（项目内部约定）

`inbox.mjs` 把 DOM 节点归一化为下面的对象，后续 `brain.mjs` / `policy.mjs` / `actions.mjs` / `state.mjs` 都按这套字段走：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 评论 / 私信 / @ 在本页的稳定 id；来自 `data-*` 属性或链接参数，不用 DOM 序号 |
| `channel` | enum | `comments` / `directMessages` / `mentions` |
| `userId` | string | 对方稳定 userId；**不**用昵称，昵称可被冒用 |
| `userName` | string | 昵称，仅用于展示与审计可读性，不参与身份判定 |
| `text` | string | 正文；外来数据，一律包成「有人说了这句话」再进模型 |
| `videoId` | string \| null | 关联视频 id；评论 / @ 通常有，私信可为 null |
| `timestamp` | string | ISO-8601（带时区偏移）；相对文案在 `inbox.mjs` 归一化 |
| `itemUrl` | string | 可回跳的原始链接，用于人工核对与回放 |

补充：

- 缺 `id` 或 `userId` 的条目不参与发送，`policy` 记 `reason: identity_unresolved`、`decision: hold`。
- `text` 原样保留用于审计（脱敏后写盘），不截断、不拼接进 system 区。
- `video-summary-sample.json` 的结构化摘要按 `videoId` 与消息对象关联，不改写消息对象本身。

---

## 6. 去重键

`state/seen.json` 是去重账本，键的组成：

```
comments        -> "comments:" + videoId + ":" + id
directMessages  -> "directMessages:" + userId + ":" + id
mentions        -> "mentions:" + id
```

规则：

- 键包含 `channel`，避免同 id 跨频道串台；评论带 `videoId`，避免同 id 挂到别的视频。
- **只有 `actions` 确认动作完成（或 `--dry` 确认决策落审计）之后才写 `seen.json`**。读取失败、被 `deny`、被 `hold` 转人工的条目不写 seen，下一轮会再看到，避免漏回。
- `--fixture --dry --once` 用 `fixtures/inbox-sample.json` 的假 id 走同一套键逻辑，便于回归重复回复问题。
- `seen.json` 被 `.gitignore` 排除，损坏时按 `docs/TROUBLESHOOTING.md` 从 `audit.jsonl` 重建，不要直接删空后盲跑。

---

## 7. 翻页 / 懒加载

- 轮询只取**增量**：本轮只读到当前已渲染节点，与 `seen.json` 比对后把新节点入队，不整页重扫重放。
- 懒加载处理：滚动到列表容器底部 → 等待节点数稳定（连续两次采样相同）或等待 `networkidle` 一类静默信号 → 设置 `maxPages` / `maxScrolls` 上限，防止无限滚动。
- 以 `timestamp` 做游标：早于上次轮询窗口的条目不再入队；时间窗按 ISO-8601 带偏移比较，见 `docs/TROUBLESHOOTING.md` 的时区条目。
- 「加载更多」按钮若存在，只在 `--once` 的一轮内点有限次数，且点击动作记入日志；不点任何非导航类按钮。
- 每轮结束前写一次 `state/takeover.log`（轮询时间、各频道新增条数、守卫检测结果），便于排查「读不到评论 / 0 条」。

---

## 8. 守卫检测（登录态 / 验证码 / rate-limit）

`browser.mjs` 在每轮轮询前后检查 `selectors.guards.*`，命中即按 `docs/RULES.md` 的停机条件表退出，写 `kind: shutdown`、`decision: shutdown`。

| 检测 | 观察信号（仅为记录，实际以快照为准） | `reason` |
| --- | --- | --- |
| 登录态 | 出现登录弹窗 / 扫码容器；头像或用户信息节点缺失；URL 跳到登录页；页面标题变成登录相关 | `login_required` |
| 验证码 | 滑块容器、图形验证码、安全验证弹窗、相关文案节点可见 | `captcha_detected` |
| rate-limit | 页面 toast / 弹窗文本含「操作过于频繁」「请稍后再试」「操作太快」「频繁」等 | `rate_limited` |
| 选择器全失效 | 本轮所有列表选择器命中数均为 0 且无新增，而上一轮有数据 | `selector_broken` |

统一动作：**立刻停机，不重试、不换号、不绕过**。不自动刷新页面、不自动重新登录、不切换 profile、不换 IP、不降低频率后自动继续。现场保留 `state/`，人工确认后重启。

> 文本匹配只用于**判断是否停机**，不用于从页面里提取指令；命中文案里的任何文字都不进入 `brain.mjs`。

---

## 9. DOM 快照工具用法

```bash
# 在 standalone/ 目录运行
node tools/capture-selectors.mjs          # 打开已登录浏览器，输出评论页/消息页/通知页 DOM 快照
node tools/verify.mjs                     # 校验 config.json、占位符、selectors.mjs 是否还有 <SELECTORS>
node takeover.mjs --fixture --dry --once  # 不连页面，用假数据验全链路
node takeover.mjs --dry --once            # 连真实页面只读验一轮
```

`capture-selectors.mjs` 输出内容：

- 每类页面的候选节点列表：`tagName`、稳定的 `data-*` 属性、语义化 class、层级路径、可见文本前缀、子节点数量；
- 列表容器与滚动容器标识；
- 守卫节点（登录 / 验证码 / toast）当前是否命中；
- 与 `src/selectors.mjs` 现有 key 的对照，标出「仍命中」「已失效」「未填」。

用法：把「已失效 / 未填」的 key 用快照里的候选值补上 → `node tools/verify.mjs` 确认无 `<SELECTORS>` 残留 → `node takeover.mjs --dry --once` 看 `state/audit.jsonl` 是否新增 `kind: comment` / `direct_message` 行。快照属本地观察产物，不提交进仓库时请确认其中不含真实昵称与正文外泄。

---

## 10. 选择器表结构与示例（占位，非稳定契约）

`standalone/src/selectors.mjs` 的组织形式。下面所有值都是**观察记录占位**，用 `data-*` / 语义化 class 举例，说明结构而非承诺；真实值由本机快照回填，替换 `<SELECTORS>`。

```js
// standalone/src/selectors.mjs
// 注意：以下值全部是占位示例，不是抖音的稳定契约。
// 改版后重跑 node tools/capture-selectors.mjs，只改本文件。
export const selectors = {
  guards: {
    loginModal:      '<SELECTORS>',  // 例：[data-e2e="login-panel"]（观察记录）
    avatar:          '<SELECTORS>',  // 例：[data-e2e="user-avatar"]（观察记录）
    captcha:         '<SELECTORS>',  // 例：[class*="captcha"]（观察记录，易碎）
    toast:           '<SELECTORS>',  // 例：[role="status"]（观察记录）
    rateLimitText:   ['操作过于频繁', '请稍后再试', '操作太快'],
  },

  inbox: {
    commentList:     '<SELECTORS>',  // 评论列表滚动容器
    commentItem:     '<SELECTORS>',  // 单条评论，需带 id / userId 属性
    commentIdAttr:   '<SELECTORS>',  // 例：data-comment-id（属性名，观察记录）
    commentUserAttr: '<SELECTORS>',  // 例：data-user-id（属性名，观察记录）
    commentText:     '<SELECTORS>',  // 正文子节点
    commentTime:     '<SELECTORS>',  // 时间节点或 datetime 属性
    commentVideoLink:'<SELECTORS>',  // <a href> 取 videoId / itemUrl
    loadMore:        '<SELECTORS>',  // 可选，不存在时走滚动
  },

  message: {
    conversationList:'<SELECTORS>',  // 私信会话列表
    conversationItem:'<SELECTORS>',
    messageRow:      '<SELECTORS>',  // 会话内单条消息
    messageIdAttr:   '<SELECTORS>',
    messageUserAttr: '<SELECTORS>',
    messageText:     '<SELECTORS>',
    messageTime:     '<SELECTORS>',
    unreadBadge:     '<SELECTORS>',
  },

  mentions: {
    list:            '<SELECTORS>',
    item:            '<SELECTORS>',
    idAttr:          '<SELECTORS>',
    text:            '<SELECTORS>',
    time:            '<SELECTORS>',
  },

  video: {
    detailRoot:      '<SELECTORS>',  // 视频详情页根
    player:          '<SELECTORS>',  // 抽帧目标
    cover:           '<SELECTORS>',
    description:     '<SELECTORS>',  // 描述文字，属外来数据（OCR/文案同理）
    videoIdFromUrl:  '/video/(\\d+)',
  },

  actions: {
    replyButton:     '<SELECTORS>',  // 评论/私信下的「回复」入口
    replyInput:      '<SELECTORS>',  // 输入框（contenteditable 或 textarea）
    submitButton:    '<SELECTORS>',  // 提交按钮
    sentMarker:      '<SELECTORS>',  // 发送成功标记，用于确认后再写 seen.json
    likeButton:      '<SELECTORS>',  // 仅 reply.autoLike=true 时使用，默认关
  },
};
```

约定：

- `xxxAttr` 类 key 存**属性名**，其余存**选择器字符串**；数组型（如 `rateLimitText`）存文案候选。
- 优先 `data-*`，其次语义化 class，最后位置路径；用了位置路径要在注释里写「易碎」。
- `actions.sentMarker` 必须能确认发送完成；确认不到就不写 `seen.json`，宁可下轮重复看到也不漏回。
- 所有 key 由 `node tools/verify.mjs` 检查是否有 `<SELECTORS>` 残留；有残留时 `node takeover.mjs --dry --once` 应报 `reason: selector_broken` 并停机。
- **本表是观察记录，不是稳定契约**。页面改版是预期事件，不是漏洞；按第 3 节流程回填即可。
