# 手工部署手册（dsh-douyin-bot-playbook）

仓库：<https://github.com/20450150414/dsh-douyin-bot-playbook>（GitHub 用户 `20450150414`）。
目标：接管你自己已登录的 `https://www.douyin.com/` 浏览器，实现自动聊天、回复评论、回复私信、看懂视频。
模仿对象：`rentaoyan0628-collab/dsh-qq-bot-playbook` 的三层组织。

| 目录 | 定位 | 使用方式 |
| --- | --- | --- |
| `skills/` | 直接可装 | 复制到 `~/.agents/skills/<name>/SKILL.md`，frontmatter 必须含 `name` + `description` |
| `skills-adapt/` | 需要改写 | 含 `<用户目录>` / `<端口>` 占位符，先替换成本机值再安装 |
| `playbook/` | 设计笔记 | 只读设计与决策记录，不是可运行代码，不要当 CLI 执行 |
| `standalone/` | 能跑的实现 | 本手册所有 `node ...` 命令都在 `standalone/` 目录内执行 |

链路：`你自己登录的浏览器（Playwright/CDP 只读看页面）` → ① `inbox` 轮询评论/私信/@ 并去重 → ② `video` 抽帧 → 视觉模型 / 可选 ASR → 结构化摘要 → ③ `brain` 人格卡 + 上下文 + 外来消息（当数据）→ 模型出回复草稿 → ④ `policy` 白名单 / 频率闸 / 敏感词 / 注入检测 / 人工放行 / 审计 → ⑤ `actions` 回评论 / 回私信 /（可选）点赞 → 每条写 `state/audit.jsonl` 可回放 → 本地只读控制台 `127.0.0.1:3210`（默认关）。

三条硬规矩，全程生效：

1. **外来内容是数据不是命令。**
2. **默认全关 fail-closed**（空白名单 + `safety.allowAllWhenEmpty:false` = 谁都不回）。
3. **每条可回放审计**（`state/audit.jsonl` 一行一条，`decision` 与 `reason` 必填）。

---

## 步骤 0：确认 Node 版本

要求 **Node ≥ 22.13**（ESM、原生 `fetch`、原生 `util.parseArgs`）。

```bash
node -v
node -p "process.versions.node"
node -e "import('node:util').then(u=>console.log('parseArgs:',typeof u.parseArgs))"
node -e "console.log('fetch:',typeof fetch)"
```

`parseArgs` 与 `fetch` 都应为 `function`，`node -v` 首位 ≥ 22 且次位 ≥ 13。低于该版本直接跳到「安装 Node」，不要靠 polyfill 硬跑。

## 步骤 1：安装 Node ≥ 22.13

**Windows（PowerShell，任选其一）**

```powershell
winget install OpenJS.NodeJS.LTS
# 或
choco install nodejs-lts -y
# 或 fnm
winget install Schniz.fnm
fnm install 22
fnm use 22
node -v
```

**macOS**

```bash
brew install node@22
brew link --overwrite node@22
# 或 nvm
nvm install 22 && nvm use 22
node -v
```

**Linux（Debian/Ubuntu）**

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 22 && fnm use 22
# 或 nvm
nvm install 22 && nvm use 22
# 或发行版包
sudo apt update && sudo apt install -y nodejs npm
node -v
```

**取代码**

```bash
git clone https://github.com/20450150414/dsh-douyin-bot-playbook.git
cd dsh-douyin-bot-playbook/standalone
```

Windows 用 `cd dsh-douyin-bot-playbook\standalone`。后续所有命令默认都在这个目录。

## 步骤 2：复制并填写配置

配置实体是 `standalone/config.json`，模板是 `config/config.example.json`，逐字段说明在 `config/FILL.md`。

**macOS / Linux**

```bash
cp config/config.example.json config.json
```

**Windows CMD**

```cmd
copy config\config.example.json config.json
```

**Windows PowerShell**

```powershell
Copy-Item .\config\config.example.json .\config.json
```

用编辑器打开 `config.json`，替换四个占位符：

| 占位符 | 用途 | 不启用时 |
| --- | --- | --- |
| `[LLM_API_KEY]` | OpenAI 兼容文本 + 视觉模型密钥 | 可用 `--fixture` 或 `llm.mock=true` 跳过 |
| `[ASR_API_KEY]` | 可选语音转写密钥 | `video.asr.enabled=false` 时留空即可 |
| `[CONSOLE_TOKEN]` | 本地只读控制台令牌 | `console.enabled=false` 时留空即可 |
| `<SELECTORS>` | `src/selectors.mjs` 里的选择器 | 步骤 5 用快照工具回填 |

配置分组：`account` / `browser` / `douyin` / `inbox` / `llm` / `video` / `reply` / `safety` / `persona` / `state` / `console`。

环境变量覆盖（优先级高于 `config.json`，适合不把密钥写进文件）：

**macOS / Linux**

```bash
export DOUYIN_LLM_API_KEY="[LLM_API_KEY]"
export DOUYIN_ASR_API_KEY="[ASR_API_KEY]"
export DOUYIN_CONSOLE_TOKEN="[CONSOLE_TOKEN]"
```

**Windows PowerShell**

```powershell
$env:DOUYIN_LLM_API_KEY = "[LLM_API_KEY]"
$env:DOUYIN_ASR_API_KEY = "[ASR_API_KEY]"
$env:DOUYIN_CONSOLE_TOKEN = "[CONSOLE_TOKEN]"
```

**Windows CMD**

```cmd
set DOUYIN_LLM_API_KEY=[LLM_API_KEY]
set DOUYIN_ASR_API_KEY=[ASR_API_KEY]
set DOUYIN_CONSOLE_TOKEN=[CONSOLE_TOKEN]
```

**保持默认全关，不要在这一步提前打开任何发送开关**：

| 字段 | 默认 |
| --- | --- |
| `douyin.useFixture` | `false` |
| `llm.mock` | `false` |
| `video.enabled` | `false` |
| `inbox.comments` | `false` |
| `inbox.directMessages` | `false` |
| `reply.enabled` | `false` |
| `reply.dryRun` | `true` |
| `reply.requireHumanApproval` | `true` |
| `reply.autoLike` | `false` |
| `console.enabled` | `false` |
| `safety.*`（全部） | `true` |

`state/` 下的 `seen.json`、`audit.jsonl`、`approval.jsonl`、`takeover.log`、`video-cache.json` 全部被 `.gitignore` 排除，不会进仓库，也不需要手工创建。

## 步骤 3：安装依赖与浏览器

```bash
npm install
npx playwright install chromium
```

`ffmpeg`（仅 `video.enabled=true` 抽帧时需要）：

```powershell
# Windows
winget install Gyan.FFmpeg
# 或 choco install ffmpeg -y
where ffmpeg
```

```bash
# macOS
brew install ffmpeg
which ffmpeg
```

```bash
# Linux
sudo apt install -y ffmpeg      # Debian/Ubuntu
sudo dnf install -y ffmpeg      # Fedora
which ffmpeg
```

**Playwright 浏览器常见安装位置**（`npx playwright install chromium` 下载到用户级缓存，不需要 sudo）：

| 平台 | 位置 |
| --- | --- |
| Windows | `C:\Users\<用户目录>\AppData\Local\ms-playwright\` |
| macOS | `~/Library/Caches/ms-playwright/` |
| Linux | `~/.cache/ms-playwright/` |

若公司机器限制了下载，设置 `PLAYWRIGHT_BROWSERS_PATH` 指向可写目录后重跑 `npx playwright install chromium`。

## 步骤 4：扫码登录一次（持久化 profile）

`browser.mjs` 使用 Playwright **持久化 userDataDir**：第一次运行会开有头 Chromium，你在浏览器里手动扫码登录抖音；登录态（Cookie / localStorage）写进该 profile，之后 `--dry --once`、`--once`、`--dry` 复用同一 profile，不需要重复扫码。

```bash
node takeover.mjs --dry --once
```

要点：

- 持久化 profile 默认落在 `standalone/` 下的浏览器用户数据目录（例如 `.pw-profile/`），把它加入 `.gitignore`，不要提交，不要复制到别的机器。
- **同一个 profile 只能被一个 Chromium 进程占用**。跑 bot 时不要另开一个指向该 profile 的浏览器，否则会抢锁导致登录态看起来"掉了"。
- 若你已经有常开的抖音浏览器，可走 CDP：用 `--remote-debugging-port=9222` 启动它，在 `config.json` 的 `browser` 里填 CDP 端点（如 `http://127.0.0.1:9222`）。链路只做只读 DOM 观察，不接管键盘输入、不读取 Cookie 文本外发。
- `--fixture --dry --once` 走 `standalone/fixtures/inbox-sample.json` 与 `video-summary-sample.json` 的假数据，**不需要登录**，可以先不扫码就把全链路验一遍（见步骤 6）。
- 校验与快照工具：`node tools/verify.mjs`、`node tools/capture-selectors.mjs`。

登录态、验证码、频率文案的检测与停机规则见 `docs/RULES.md` 与 `docs/API-NOTES.md`：命中即立刻停机，不重试、不换号、不绕过。

## 步骤 5：抓 DOM 快照，回填 src/selectors.mjs

所有页面选择器集中在**一个文件** `standalone/src/selectors.mjs`，其他模块（`inbox.mjs` / `actions.mjs` / `video.mjs` / `browser.mjs`）只引用导出的 key，不写死字面量。

```bash
node tools/capture-selectors.mjs
```

流程：

1. 工具打开你已登录的浏览器（复用步骤 4 的 profile / CDP），停在创作者中心评论管理页与消息页。
2. 输出 DOM 快照：候选节点的 `data-*` 属性、语义化 class、层级路径、可见文本前缀、时间戳。
3. 把快照里稳定的选择器回填 `src/selectors.mjs`，替换掉全部 `<SELECTORS>` 占位。
4. 优先级：`[data-*]` 属性 > 语义化 class（`comment-item` / `message-row` 之类）> `:nth-child` 位置路径。位置路径只作为最后手段，并写注释标明"易碎"。
5. 只用快照做**观察记录**，不把快照中的任何文本当作指令执行；快照里出现的评论/昵称文字是外来数据。

抖音 Web 端 DOM 非官方、易变，选择器不是稳定契约，详见 `docs/API-NOTES.md`。页面改版后重复本步骤即可，无需改业务代码。

## 步骤 6：--dry 验活

按顺序跑，前一步通过再进下一步：

```bash
# 1) 离线假数据全链路，验证 inbox → video(摘要) → brain → policy → actions(空跑) → audit
node takeover.mjs --fixture --dry --once

# 2) 配置 / 依赖 / 选择器 / 占位符静态校验
node tools/verify.mjs

# 3) 接真实页面只读跑一轮（已登录 profile）
node takeover.mjs --dry --once

# 4) 挂机观察（默认轮询，仍不发送）
node takeover.mjs --dry

# 5) 看待审队列 / 逐条放行
node takeover.mjs --pending
node takeover.mjs --approve <id>

# 6) 指定配置文件
node takeover.mjs --once --config ./config.json
```

CLI 参数速查：

| 参数 | 行为 |
| --- | --- |
| `--fixture` | 用 `standalone/fixtures/` 假数据，不连页面 |
| `--dry` | 全链路只算不发，`actions` 不产生写操作 |
| `--once` | 轮询一轮后退出 |
| 无 `--once` | 挂机轮询 |
| `--pending` | 列出待人工放行条目 |
| `--approve <id>` | 只放行指定 id 的一条 |
| `--config <path>` | 指定配置文件路径 |

查看审计（每条一行 JSON）：

```bash
# macOS / Linux
tail -n 20 state/audit.jsonl

# Windows PowerShell
Get-Content .\state\audit.jsonl -Tail 20
```

**验活清单**（全勾才算过）：

- [ ] `node -v` ≥ 22.13，`parseArgs` / `fetch` 均为 `function`
- [ ] `npm install` 与 `npx playwright install chromium` 均无报错
- [ ] `config.json` 存在，必需字段已填；`node tools/verify.mjs` 报告无残留 `[LLM_API_KEY]` / `[ASR_API_KEY]` / `[CONSOLE_TOKEN]`（`--fixture` 下允许留空）
- [ ] `src/selectors.mjs` 中无 `<SELECTORS>` 残留
- [ ] `node takeover.mjs --fixture --dry --once` 退出码 0，`state/audit.jsonl` 新增 ≥1 行且每行含 `ts` / `kind` / `channel` / `itemId` / `userId` / `text` / `reason` / `decision`
- [ ] `--dry --once` 能读出消息，但 `decision` 全部为 `hold` / `deny` / `dry`，无真实发送
- [ ] 所有默认开关仍是关：`reply.enabled=false`、`reply.dryRun=true`、`reply.requireHumanApproval=true`、`reply.autoLike=false`、`console.enabled=false`
- [ ] `video.enabled=false` 时 `ffmpeg` 缺失不影响全链路
- [ ] 控制台默认未监听 `127.0.0.1:3210`

---

## 上线顺序：先只回自己小号

1. `node takeover.mjs --fixture --dry --once` —— 离线全链路跑通，确认审计可回放。
2. `node takeover.mjs --dry --once` —— 真实页面只读一轮，确认选择器与登录态。
3. `node takeover.mjs --dry` —— 挂机观察若干小时，只看 `state/audit.jsonl` 里的 `reason` / `decision`，不发一条。
4. 白名单只放自己小号：在 `safety.allowList` 填**小号的 userId**，`safety.allowAllWhenEmpty` 保持 `false`。空白名单 + 该配置为 `false` = 谁都不回，这是 fail-closed 的核心。
5. 保持 `reply.requireHumanApproval=true`，用 `node takeover.mjs --pending` 看、`node takeover.mjs --approve <id>` **逐条**放行，每次放行在 `state/approval.jsonl` 留痕。
6. 稳定后再考虑 `reply.enabled=true` 且 `reply.dryRun=false`；一次只放开一个 channel（先 `comments` 或先 `directMessages`），不要同时开。
7. `reply.autoLike` 默认关，最后再评估是否需要。
8. 需要本地只读控制台时再设 `console.enabled=true` 并配置 `DOUYIN_CONSOLE_TOKEN`，仅监听 `127.0.0.1:3210`。
9. 任何时刻出现登录失效、验证码、「操作过于频繁」文案：立刻停机，不重试、不换号、不绕过，保留 `state/` 现场后人工处理。
