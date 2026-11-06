#!/usr/bin/env node
/**
 * verify.mjs —— 离线自检。不联网、不打开浏览器、不发送。
 *   node tools/verify.mjs
 *   node tools/verify.mjs --config ../../config/config.example.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig, findPlaceholders, STANDALONE_DIR, REPO_DIR } from '../src/config.mjs';

const values = parseArgs({
  options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  strict: true,
}).values;

const results = [];
const add = (ok, label, detail = '', soft = false) => results.push({ ok, label, detail, soft });

function nodeOk() {
  const m = process.version.match(/^v(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 22 || (maj === 22 && min >= 13);
}

async function playwrightOk() {
  try { await import('playwright'); return true; } catch { return false; }
}

function ffmpegOk() {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function main() {
  if (values.help) { console.log('用法：node tools/verify.mjs [--config <path>]'); return; }
  console.log('dsh-douyin-takeover 自检（离线）\n' + '='.repeat(60));

  add(nodeOk(), 'Node.js ≥ 22.13', process.version);

  let cfg, paths, configSource;
  try {
    ({ cfg, paths, configSource } = loadConfig({ config: values.config }));
    add(true, '配置文件可解析', configSource);
  } catch (e) {
    add(false, '配置文件可解析', e.message);
    console.log(formatResults());
    process.exit(1);
  }

  // 占位符：模板里本来就有，跑真机前用本地 config.json 或环境变量替换即可，不算硬性失败
  const ph = findPlaceholders(cfg);
  add(ph.length === 0, '占位符已替换',
    ph.length ? `${ph.length} 处模板占位符（软提示：可用环境变量覆盖，或填进 standalone/config.json）：${ph.map((p) => p.key).join(', ')}` : '无残留', true);

  // 关键文件
  const files = [
    ['假消息 fixture', paths.fixtureInbox, false],
    ['假视频摘要 fixture', paths.fixtureVideo, false],
    ['系统提示词', paths.systemPrompt, true],
    ['选择器表', path.join(STANDALONE_DIR, 'src', 'selectors.mjs'), false],
    ['主循环', path.join(STANDALONE_DIR, 'takeover.mjs'), false],
  ];
  for (const [label, f, soft] of files) {
    add(fs.existsSync(f), label, soft && !fs.existsSync(f) ? `${f}（软提示：brain.mjs 有内置兜底提示词，可离线跑）` : f, soft);
  }
  for (const [i, f] of paths.extraPrompts.entries()) {
    add(fs.existsSync(f), `追加提示词 #${i + 1}`, f, true);
  }

  // 目录可写
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    const probe = path.join(paths.stateDir, '.verify-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    add(true, 'state/ 可写', paths.stateDir);
  } catch (e) { add(false, 'state/ 可写', e.message); }

  // 安全默认值
  const safe = !cfg.reply.enabled || cfg.reply.dryRun || cfg.reply.requireHumanApproval;
  add(safe, '自动发送默认收敛', `enabled=${cfg.reply.enabled} dryRun=${cfg.reply.dryRun} human=${cfg.reply.requireHumanApproval}`);
  add(cfg.reply.whitelist.allowAllWhenEmpty !== true || !!cfg.demo,
    '白名单 fail-closed', `allowAllWhenEmpty=${cfg.reply.whitelist.allowAllWhenEmpty}`);
  add(!!cfg.safety.treatExternalTextAsData, '外来文字当数据', String(cfg.safety.treatExternalTextAsData));
  add((cfg.safety.injectionPatterns || []).length > 0, '注入规则非空', `${(cfg.safety.injectionPatterns || []).length} 条`);
  add((cfg.safety.secretPatterns || []).length > 0, '密钥拦截规则非空', `${(cfg.safety.secretPatterns || []).length} 条`);

  // 可选依赖（软）
  add(await playwrightOk(), 'playwright 可用（仅真机模式需要）', '缺了不影响 --fixture 演示', true);
  add(await ffmpegOk(), 'ffmpeg 可用（仅抽帧/ASR 需要）', '缺了不影响文本链路', true);

  console.log(formatResults());
  const failed = results.filter((r) => !r.ok);
  const hard = failed.filter((r) => !r.soft);
  const soft = failed.filter((r) => r.soft);
  console.log(`\n结论：${results.length - failed.length}/${results.length} 项通过；硬性未通过 ${hard.length} 项，软提示 ${soft.length} 项。`);
  if (hard.length) {
    console.log('先修好上面标 ✗ 的硬性项，再跑 node takeover.mjs --fixture --dry --once');
    process.exitCode = 1;
  } else {
    console.log('可以跑离线演示了：node takeover.mjs --fixture --dry --once');
  }
}

function formatResults() {
  return results.map((r) => `${r.ok ? '✓' : (r.soft ? '!' : '✗')} ${r.label.padEnd(32)} ${r.detail}`).join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
