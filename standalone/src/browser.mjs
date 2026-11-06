/**
 * browser.mjs —— 只在「真正需要浏览器」时才加载 playwright。
 *
 * 这是 --fixture --dry --once 能零依赖离线跑通的关键：
 * 静态导入本模块没问题，但 import('playwright') 发生在 getBrowser() 调用时。
 *
 * 只做：打开你自己登录的页面、读 DOM、检查异常信号、导出 DOM 快照。
 * 不做：抓包、签名伪造、接口重放、验证码/风控绕过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, log } from './util.mjs';
import { loadSelectors } from './selectors.mjs';

export class StopSignal extends Error {
  constructor(signal, detail = '') {
    super(`检测到停机信号：${signal}${detail ? ` (${detail})` : ''}`);
    this.name = 'StopSignal';
    this.signal = signal;
  }
}

let _session = null;

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (e) {
    throw new Error(
      `缺少 playwright。请在 standalone/ 下执行：npm install && npx playwright install chromium\n原始错误：${e.message}`,
    );
  }
}

/**
 * 打开（或复用）浏览器会话。
 * - 配了 cdpEndpoint → connectOverCDP，接管你已经开着的浏览器（推荐，最省事）
 * - 否则 → launchPersistentContext，用 account.profileDir 保存登录态
 */
export async function getBrowser(cfg, paths) {
  if (_session) return _session;
  const { chromium } = await importPlaywright();
  ensureDir(paths.profileDir);

  let context;
  let browser = null;
  if (cfg.browser.cdpEndpoint) {
    browser = await chromium.connectOverCDP(cfg.browser.cdpEndpoint);
    context = browser.contexts()[0] || (await browser.newContext());
  } else {
    context = await chromium.launchPersistentContext(paths.profileDir, {
      headless: !!cfg.browser.headless,
      channel: cfg.browser.channel && cfg.browser.channel !== 'chromium' ? cfg.browser.channel : undefined,
      slowMo: Number(cfg.browser.slowMoMs) || 0,
      viewport: cfg.browser.viewport,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  }
  context.setDefaultTimeout(Number(cfg.browser.navigationTimeoutMs) || 30000);
  _session = { context, browser, page: null };
  return _session;
}

export async function getPage(cfg, paths) {
  const s = await getBrowser(cfg, paths);
  if (!s.page) {
    const pages = s.context.pages();
    s.page = pages.length ? pages[0] : await s.context.newPage();
  }
  return s.page;
}

export async function openUrl(cfg, paths, url, { settleMs } = {}) {
  const page = await getPage(cfg, paths);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(cfg.browser.navigationTimeoutMs) || 30000 });
  await page.waitForTimeout(Number(settleMs ?? cfg.douyin.pageSettleMs) || 1500);
  await checkSignals(cfg, page);
  return page;
}

/**
 * 页面级异常检测：登录失效 / 验证码 / 操作频繁。
 * 命中且对应 safety 开关为 true → 抛 StopSignal，主循环立刻停机。
 */
export async function checkSignals(cfg, page) {
  const sel = loadSelectors();
  const s = cfg.safety || {};
  let bodyText = '';
  let url = '';
  try {
    bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 20000) || '');
    url = page.url();
  } catch {
    return { ok: true, url: '', signal: null };
  }
  const groups = [
    ['loginExpired', s.stopOnLoginExpired !== false, sel.signals.loginExpired],
    ['captcha', s.stopOnCaptcha !== false, sel.signals.captcha],
    ['rateLimit', s.stopOnRateLimitHint !== false, sel.signals.rateLimit],
  ];
  for (const [name, enabled, patterns] of groups) {
    if (!enabled) continue;
    const hit = (patterns || []).find((p) => bodyText.includes(p));
    // 登录页本身以 URL 判定，避免把消息里的「请登录」文字误判
    const urlHit = name === 'loginExpired' && /\/login|\/passport/i.test(url);
    if (hit || urlHit) {
      log('warn', `页面异常信号 ${name}`, { hit: hit || url });
      throw new StopSignal(name, hit || url);
    }
  }
  return { ok: true, url, signal: null };
}

/** 把当前页面 DOM 导到 state/ 下，供 capture-selectors / 人工改选择器用 */
export async function dumpDom(page, paths, tag = 'page') {
  ensureDir(paths.stateDir);
  const stamp = nowIso().replace(/[:.]/g, '-');
  const base = path.join(paths.stateDir, `dom-dump-${tag}-${stamp}`);
  const html = await page.content();
  const text = await page.evaluate(() => document.body?.innerText || '');
  fs.writeFileSync(`${base}.html`, html, 'utf8');
  fs.writeFileSync(`${base}.txt`, text, 'utf8');
  return { html: `${base}.html`, text: `${base}.txt` };
}

export async function closeBrowser() {
  if (!_session) return;
  try { await _session.context.close(); } catch { /* ignore */ }
  try { if (_session.browser) await _session.browser.close(); } catch { /* ignore */ }
  _session = null;
}
