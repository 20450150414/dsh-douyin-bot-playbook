#!/usr/bin/env node
/**
 * capture-selectors.mjs —— 把当前页面 DOM 导成「候选选择器清单」，用来改 src/selectors.mjs。
 *
 *   node tools/capture-selectors.mjs                      真浏览器：打开评论页 + 私信页
 *   node tools/capture-selectors.mjs --from-file a.html   离线：分析一份已保存的 DOM 快照
 *
 * 输出（都在 state/ 下，.gitignore 已排除）：
 *   dom-dump-<tag>-<ts>.html / .txt    原始快照
 *   selector-candidates.json           候选选择器 + 统计 + 建议
 *
 * 本工具只读页面，不点任何发送按钮、不绕过验证码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { ensureDir, nowIso, log, setLogFile } from '../src/util.mjs';
import { openUrl, dumpDom, closeBrowser } from '../src/browser.mjs';

const values = parseArgs({
  options: {
    'from-file': { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
}).values;

const KEYWORDS = ['comment', 'reply', 'message', 'chat', 'conversation', 'content', 'user', 'nick', 'time', 'send', 'input', 'list', 'item'];

function analyzeHtml(html) {
  const counts = new Map();
  const add = (k) => counts.set(k, (counts.get(k) || 0) + 1);

  // data-e2e / data-* 属性
  for (const m of html.matchAll(/\b(data-[a-z0-9-]+)\s*=\s*["'][^"']*["']/gi)) add(`[${m[1]}]`);
  // class 名里带关键词的
  for (const m of html.matchAll(/class\s*=\s*["']([^"']+)["']/gi)) {
    for (const c of m[1].split(/\s+/)) {
      if (KEYWORDS.some((k) => c.toLowerCase().includes(k))) add(`.${c}`);
    }
  }
  // 关键元素
  for (const m of html.matchAll(/<(textarea|input|video|a|button)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    add(`<${tag}>`);
    if (/contenteditable/i.test(m[0])) add('[contenteditable="true"]');
    if (/placeholder\s*=\s*["']([^"']*)/i.test(m[0])) {
      add(`[placeholder*="${m[0].match(/placeholder\s*=\s*["']([^"']*)/i)[1].slice(0, 20)}"]`);
    }
  }
  // 按钮文案
  for (const m of html.matchAll(/<button[^>]*>([\s\S]{0,60}?)<\/button>/gi)) {
    const t = m[1].replace(/<[^>]+>/g, '').trim();
    if (t && t.length < 20) add(`button:has-text("${t}")`);
  }
  // 视频链接
  const videoIds = [...html.matchAll(/\/video\/([A-Za-z0-9_-]{6,})/g)].map((m) => m[1]);
  // 疑似风险词（只是提示，不是判定）
  const riskWords = ['验证码', '安全验证', '操作过于频繁', '请登录', '登录后查看']
    .filter((w) => html.includes(w));

  const candidates = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([selector, count]) => ({ selector, count }));

  return {
    generatedAt: nowIso(),
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    candidates,
    videoIdsFound: [...new Set(videoIds)].slice(0, 20),
    riskWords,
    hint: '把 candidates 里出现次数高、语义对得上的选择器填进 src/selectors.mjs 对应字段；或写 selectors.local.json 覆盖。改完先跑 --dry --once 确认能读到条数。',
  };
}

async function main() {
  if (values.help) {
    console.log('用法：node tools/capture-selectors.mjs [--from-file <dom.html>] [--config <path>]');
    return;
  }
  const { cfg, paths } = loadConfig({ config: values.config });
  ensureDir(paths.stateDir);
  setLogFile(paths.log);

  let html = '';
  if (values['from-file']) {
    const f = path.isAbsolute(values['from-file']) ? values['from-file'] : path.resolve(process.cwd(), values['from-file']);
    if (!fs.existsSync(f)) { console.error(`文件不存在：${f}`); process.exit(1); }
    html = fs.readFileSync(f, 'utf8');
    log('info', '离线分析 DOM 快照', { file: f, bytes: html.length });
  } else {
    const urls = [
      ['comment', cfg.douyin.commentInboxUrl],
      ['dm', cfg.douyin.dmInboxUrl],
    ].filter(([, u]) => !!u);
    for (const [tag, url] of urls) {
      try {
        const page = await openUrl(cfg, paths, url);
        const dump = await dumpDom(page, paths, tag);
        log('info', '已导出 DOM 快照', { tag, ...dump });
        html += await page.content();
      } catch (e) {
        log('error', '导出失败（登录态/选择器/风控？）', { tag, url, error: e.message });
      }
    }
    await closeBrowser();
    if (!html) {
      console.error('没有拿到任何 DOM。若缺少 playwright：cd standalone && npm install && npx playwright install chromium');
      process.exit(1);
    }
  }

  const report = analyzeHtml(html);
  const out = path.join(paths.stateDir, 'selector-candidates.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n候选选择器已写入：${out}\n`);
  console.log(`HTML 字节：${report.htmlBytes}   候选数：${report.candidates.length}   视频 ID：${report.videoIdsFound.length}`);
  if (report.riskWords.length) console.log(`⚠ 页面里出现风险词：${report.riskWords.join('、')}（停机信号已内置，不要绕过）`);
  console.log('\n出现次数最多的 15 个候选：');
  for (const c of report.candidates.slice(0, 15)) console.log(`  ${String(c.count).padStart(4)}  ${c.selector}`);
  console.log(`\n${report.hint}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
