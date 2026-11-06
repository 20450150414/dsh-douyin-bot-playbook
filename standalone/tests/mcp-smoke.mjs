#!/usr/bin/env node
/**
 * mcp-smoke.mjs —— --mcp 链路的离线回归
 *
 *   node tests/mcp-smoke.mjs
 *
 * 用 tests/mock-mcp-server.mjs 当能力层（返回形状对齐 vendor/douyin-mcp：ok / needLogin / verified），
 * 模型走 llm.mock（确定性草稿）。不碰浏览器、不联网、不会真发送。
 *
 * 校验：统一对象归一化、四道闸、审计计数、去重与 exclude_cids、未登录停机、人工放行仍受 dry-run 约束。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { STANDALONE_DIR } from '../src/config.mjs';

const CONFIG = path.join(STANDALONE_DIR, 'tests', 'config.mock-mcp.json');
const STATE = path.join(STANDALONE_DIR, 'state', 'mock');
const AUDIT = path.join(STATE, 'audit.jsonl');
const SEEN = path.join(STATE, 'seen.json');
const CACHE = path.join(STATE, 'video-cache.json');
const APPROVAL = path.join(STATE, 'approval.jsonl');

const results = [];
const check = (label, ok, detail = '') => { results.push({ label, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${label.padEnd(36)} ${detail}`); };

function readJsonl(f) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function readJson(f, fallback) { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback; }
function counts(rows) { const o = {}; for (const r of rows) o[r.kind] = (o[r.kind] || 0) + 1; return o; }
function reset() { if (fs.existsSync(STATE)) fs.rmSync(STATE, { recursive: true, force: true }); }

function run(extraEnv = {}, args = ['--mcp', '--dry', '--once', '--config', CONFIG]) {
  const r = spawnSync(process.execPath, [path.join(STANDALONE_DIR, 'takeover.mjs'), ...args], {
    cwd: STANDALONE_DIR, env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 90000,
  });
  return r;
}

function step1_firstRound() {
  const first = run();
  check('首轮退出码 0', first.status === 0, `status=${first.status} ${first.stderr?.slice(-160) ?? ''}`);
  const rows = readJsonl(AUDIT);
  const c = counts(rows);
  check('读到 6 条（4 评论 + 2 私信）', c.polled === 6, `polled=${c.polled ?? 0}`);
  check('没有任何真发送', !c.sent, `sent=${c.sent ?? 0}`);
  check('dry 也没触发（全进待审）', !c.dry, `dry=${c.dry ?? 0}`);
  check('待审 5 条', c.queued === 5, `queued=${c.queued ?? 0}`);
  check('跳过 1 条（黑名单关键词）', c.skipped === 1, `skipped=${c.skipped ?? 0}`);

  const deny = rows.find((r) => r.kind === 'skipped' && /denylist-keyword/.test(r.reason || ''));
  check('黑名单命中（加微信/免费领）', !!deny, deny?.reason ?? '未命中');
  const inj = rows.find((r) => r.kind === 'queued' && /injection-suspect/.test(r.reason || ''));
  check('注入强制转人工', !!inj, inj?.reason ?? '未命中');

  const polled = rows.filter((r) => r.kind === 'polled');
  const byChannel = (ch) => new Set(polled.filter((r) => r.channel === ch).map((r) => r.itemId)).size;
  check('私信归一化（2 条入站）', byChannel('dm') === 2, `dm=${byChannel('dm')}`);
  check('评论归一化（4 条）', byChannel('comment') === 4, `comment=${byChannel('comment')}`);
  const ids = new Set(polled.map((r) => r.itemId));
  check('评论 id = cmt:<aweme>:<cid>', [...ids].some((i) => /^cmt:\d{15,}:c_\d+$/.test(i)), [...ids].find((i) => i.startsWith('cmt:')) ?? '');
  check('私信 id = dm:<name>:<messageId>', [...ids].some((i) => /^dm:.+:m_\d+$/.test(i)), [...ids].find((i) => i.startsWith('dm:')) ?? '');

  const cache = readJson(CACHE, {});
  const srcs = Object.values(cache).map((v) => v.summary?.source);
  check('视频摘要来源 = mcp', srcs.includes('mcp'), srcs.join(',') || '（缓存为空）');
  const seen = Object.keys(readJson(SEEN, {}));
  check('去重账本记 6 条', seen.length === 6, `seen=${seen.length}`);
}

function step2_dedupe() {
  const before = readJsonl(AUDIT).length;
  const second = run();
  const added = readJsonl(AUDIT).length - before;
  check('次轮退出码 0', second.status === 0, `status=${second.status}`);
  check('次轮无新增处理（去重 + exclude_cids）', added === 0, `新增 ${added} 行审计`);
}

function step3_notLoggedIn() {
  reset();
  const r = run({ MOCK_NOT_LOGGED_IN: '1' });
  const rows = readJsonl(AUDIT);
  const stop = rows.find((x) => x.kind === 'error' && x.reason === 'stop-signal');
  check('未登录触发停机信号', !!stop, stop ? `signal=${stop.signal}` : `未见 stop-signal；kinds=${JSON.stringify(counts(rows))}`);
  check('未登录时零发送', !counts(rows).sent, JSON.stringify(counts(rows)));
  check('停机原因是 loginExpired', stop?.signal === 'loginExpired', `signal=${stop?.signal}`);
  check('停机后进程自己退出（不吊子进程）', r.status === 0 || r.status === 1, `status=${r.status}`);
}

function step4_humanApproval() {
  reset();
  run();
  const pending = readJsonl(APPROVAL).filter((x) => x.status === 'pending');
  check('待审队列已落盘', pending.length > 0, `pending=${pending.length}`);
  if (!pending.length) return;
  const ap = run({}, ['--mcp', '--dry', '--approve', pending[0].id, '--config', CONFIG]);
  const lastLine = (ap.stdout || '').split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '';
  check('approve 在 dry-run 下不真发', /DRY/.test(ap.stdout), lastLine.slice(0, 90));
  check('approve 后仍零发送', !counts(readJsonl(AUDIT)).sent, JSON.stringify(counts(readJsonl(AUDIT))));
}

function steps() {
  console.log('=== --mcp 链路离线回归 ===\n');
  reset(); step1_firstRound();
  step2_dedupe();
  console.log('');
  step3_notLoggedIn();
  console.log('');
  step4_humanApproval();
  reset();
}

try { steps(); }
catch (e) { check('流程未抛异常', false, `${e.message} @ ${(e.stack || '').split(/\r?\n/)[1]?.trim() ?? ''}`); }
const failed = results.filter((r) => !r.ok);
console.log(`\n结论：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) { console.log('未通过项：'); for (const f of failed) console.log(`  - ${f.label}: ${f.detail}`); process.exitCode = 1; }
else console.log('--mcp 链路可用。接真账号：tools/setup-mcp.ps1 → node takeover.mjs --selfcheck → --login → --mcp --dry --once');
