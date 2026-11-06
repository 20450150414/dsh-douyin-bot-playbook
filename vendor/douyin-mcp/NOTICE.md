# vendor/douyin-mcp —— 第三方能力层（不是本仓库原创）

| 项 | 值 |
|---|---|
| 上游项目 | [kdcadmin/dsh_douyin_tools](https://github.com/kdcadmin/dsh_douyin_tools)（插件中文名「刷抖音」） |
| 上游作者 | TiAmoSS |
| 上游许可证 | MIT —— 见 [LICENSE.upstream](LICENSE.upstream) |
| 本目录来源 | 2026-11-06 从上游 `vendor/douyin-mcp/` 原样复制：`mcp_server.py`、`smoke.py`、`requirements.txt` |
| 本仓库的角色 | 只负责在它前面加放行/审计/人工放行；**不改上游行为，也不为上游 bug 负责** |

## 为什么放进来

抖音 Web 端没有面向个人账号的公开消息 API。要把「读评论、读私信、回评论、回私信、看视频」做真，
必须有人去解决页面结构、XHR 取数、登录态证据、回执确认这些脏活。上游已经把这些做掉了，
而且思路和本仓库一致：**数据优先从页面自身发出的 XHR 里取，DOM 只做兜底，取不到就如实返回空数组，不编数据**。

所以本仓库不自建一套抓包逻辑，而是把它当能力层调用，协议是 MCP over stdio。

## 上游暴露的工具（本仓库实际用到的）

只读：`douyin_check_credential` `douyin_login_qr` `douyin_login_poll` `douyin_my_posts`
`douyin_comments` `douyin_inbox` `douyin_video` `douyin_thumb` `douyin_selfcheck` `douyin_check_reply`
写动作：`douyin_comment` `douyin_chat_send`（本仓库默认不放开，见下）

本仓库的映射层在 [standalone/src/mcp-backend.mjs](../../standalone/src/mcp-backend.mjs)，
把上游返回归一成统一消息对象与视频摘要；协议客户端在 [standalone/src/mcp-client.mjs](../../standalone/src/mcp-client.mjs)。

## 三道独立刹车（缺一不可）

1. **本仓库配置层**：`reply.enabled=false` / `dryRun=true` / `requireHumanApproval=true` / 白名单 fail-closed。
2. **本仓库进程层**：只有 `reply.enabled=true` 且 `dryRun=false` 时，才给子进程传 `DOUYIN_ALLOW_WRITES=1`。
3. **上游自己的闸**：`DOUYIN_ALLOW_WRITES != 1` 时，写类工具（`douyin_like` / `douyin_comment` / `douyin_publish`
   / `douyin_share_video` / `douyin_chat_send` / `douyin_chat_sticker` / `douyin_chat_batch`）**根本不会注册成 MCP 工具**。

也就是说：默认状态下，这个 Python 子进程连「发消息」这个工具都看不到，不只是本仓库不发。

## 安装

```powershell
cd standalone
powershell -ExecutionPolicy Bypass -File tools\setup-mcp.ps1
node takeover.mjs --selfcheck
```

`.venv/`、`__pycache__/`、`*.pyc` 已在 `.gitignore` 里排除；`requirements.txt` 保持上游原文
（`mcp<2` 是硬约束：2.x 把 `FastMCP` 改名成 `MCPServer`，用 v1 API 的代码在 2.x 下起不来）。

## 边界

- 本目录代码不为绕过验证码、伪造签名、批量注册、养号、抓取他人数据提供任何能力；上游同理。
- 登录只能用你自己的账号（扫码或短信），登录态存在 `~/.dsh/douyin-duty/browser/`，不在本仓库里。
- 上游接口随抖音改版而变，出问题先 `node takeover.mjs --selfcheck` 定位在哪一层，再决定是改选择器还是回上游提 issue。
