/**
 * config.mjs —— 配置加载与路径解析
 *
 * 约定：所有相对路径以 standalone/ 目录为基准解析（不是 process.cwd()）。
 * 因此无论从仓库根 `npm run demo` 还是 `cd standalone && node ...`，行为一致。
 *
 * 优先级：CLI 覆盖 > 环境变量 > standalone/config.json > config/config.example.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STANDALONE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const REPO_DIR = fileURLToPath(new URL('../..', import.meta.url));

export function resolveFromBase(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(STANDALONE_DIR, p);
}

export function resolveFromCwd(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

const DEFAULT_CONFIG_REL = path.join(REPO_DIR, 'config', 'config.example.json');
const LOCAL_CONFIG = path.join(STANDALONE_DIR, 'config.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** 合并（仅覆盖已有分组里的键，不引入未知顶层分组） */
function applyOverride(cfg, group, key, value) {
  if (value === undefined || value === null) return;
  if (!cfg[group] || typeof cfg[group] !== 'object') cfg[group] = {};
  cfg[group][key] = value;
}

/**
 * @param {object} cli  { fixture, dry, once, config, demo }
 * @returns {{cfg: object, paths: object, configSource: string}}
 */
export function loadConfig(cli = {}) {
  let configSource;
  if (cli.config) {
    configSource = resolveFromCwd(cli.config);
    if (!fs.existsSync(configSource)) {
      throw new Error(`指定的配置文件不存在：${configSource}`);
    }
  } else if (fs.existsSync(LOCAL_CONFIG)) {
    configSource = LOCAL_CONFIG;
  } else if (fs.existsSync(DEFAULT_CONFIG_REL)) {
    configSource = DEFAULT_CONFIG_REL;
  } else {
    throw new Error('找不到配置文件：请复制 config/config.example.json 为 standalone/config.json');
  }

  const cfg = deepClone(readJson(configSource));

  // 兜底：模板若被精简过，补齐必要分组，避免后续读 undefined
  const ensure = (g, fallback = {}) => {
    if (!cfg[g] || typeof cfg[g] !== 'object') cfg[g] = fallback;
  };
  for (const g of ['account', 'browser', 'douyin', 'inbox', 'llm', 'video', 'reply', 'safety', 'persona', 'state', 'console']) ensure(g);
  if (!cfg.video.asr) cfg.video.asr = { enabled: false };
  if (!cfg.reply.whitelist) cfg.reply.whitelist = { userIds: [], keywords: [], allowAllWhenEmpty: false };
  if (!cfg.reply.denylist) cfg.reply.denylist = { userIds: [], keywords: [] };
  if (!cfg.browser.viewport) cfg.browser.viewport = { width: 1366, height: 900 };
  if (!Array.isArray(cfg.persona.extraPromptFiles)) cfg.persona.extraPromptFiles = [];
  if (!Array.isArray(cfg.safety.secretPatterns)) cfg.safety.secretPatterns = [];
  if (!Array.isArray(cfg.safety.injectionPatterns)) cfg.safety.injectionPatterns = [];

  // 环境变量覆盖（只在变量存在时生效，文件里保留占位符也可以跑）
  if (process.env.DOUYIN_LLM_API_KEY) applyOverride(cfg, 'llm', 'apiKey', process.env.DOUYIN_LLM_API_KEY);
  if (process.env.DOUYIN_ASR_API_KEY) applyOverride(cfg, 'video', 'asr', {
    ...(cfg.video.asr || {}), apiKey: process.env.DOUYIN_ASR_API_KEY,
  });
  if (process.env.DOUYIN_CONSOLE_TOKEN) applyOverride(cfg, 'console', 'token', process.env.DOUYIN_CONSOLE_TOKEN);

  // CLI 覆盖
  const demo = !!cli.fixture;
  cfg.demo = demo;
  if (cli.fixture) {
    applyOverride(cfg, 'douyin', 'useFixture', true);
    applyOverride(cfg, 'llm', 'mock', true);
    applyOverride(cfg, 'video', 'fixtureOnly', true);
    applyOverride(cfg, 'video', 'enabled', true); // 演示「看懂视频」这一步，读假摘要，不抽帧不花钱
    // 演示需要读到 dm / mention 样例
    applyOverride(cfg, 'inbox', 'comments', true);
    applyOverride(cfg, 'inbox', 'directMessages', true);
    applyOverride(cfg, 'inbox', 'mentions', true);
  }
  if (cli.dry) {
    applyOverride(cfg, 'reply', 'dryRun', true);
  }
  // 离线演示：绝不触碰真实发送，也不因空白名单把所有样例都拦掉
  // （白名单旁路只发生在 fixture + dry-run 下，policy.mjs 会显式打日志）
  if (demo) {
    applyOverride(cfg, 'reply', 'dryRun', true);
  }
  if (cli.once) cfg.once = true;
  if (cli.config) cfg.configPath = configSource;

  // 解析出所有绝对路径，集中在一处
  const stateDir = resolveFromBase(cfg.state.dir || './state');
  const joinState = (f) => path.join(stateDir, f || 'audit.jsonl');
  const paths = {
    standalone: STANDALONE_DIR,
    repo: REPO_DIR,
    configFile: configSource,
    stateDir,
    profileDir: resolveFromBase(cfg.account.profileDir || './state/browser-profile'),
    seen: joinState(cfg.state.seenFile || 'seen.json'),
    audit: joinState(cfg.state.auditFile || 'audit.jsonl'),
    approval: joinState(cfg.state.approvalFile || 'approval.jsonl'),
    log: joinState(cfg.state.logFile || 'takeover.log'),
    videoCache: joinState(cfg.state.videoCacheFile || 'video-cache.json'),
    fixtureInbox: resolveFromBase(cfg.douyin.fixtureFile || './fixtures/inbox-sample.json'),
    fixtureVideo: resolveFromBase(cfg.video.fixtureFile || './fixtures/video-summary-sample.json'),
    systemPrompt: resolveFromBase(cfg.persona.systemPromptFile || '../prompts/SYSTEM-PROMPT.md'),
    extraPrompts: cfg.persona.extraPromptFiles.map(resolveFromBase),
  };

  return { cfg, paths, configSource };
}

/** 找出仍然没被替换的占位符（verify.mjs 用） */
export function findPlaceholders(cfg) {
  const hits = [];
  const walk = (v, keyPath) => {
    if (typeof v === 'string') {
      if (/\[[A-Z_]+\]|<\s*(SELECTORS|用户目录|端口|项目路径|通知渠道)\s*>/.test(v)) {
        hits.push({ key: keyPath, value: v });
      }
    } else if (v && typeof v === 'object') {
      for (const [k, sub] of Object.entries(v)) walk(sub, keyPath ? `${keyPath}.${k}` : k);
    }
  };
  walk(cfg, '');
  return hits;
}
