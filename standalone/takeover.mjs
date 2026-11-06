#!/usr/bin/env node
/**
 * takeover.mjs —— 抖音接管主循环 + CLI
 *
 *   node takeover.mjs --fixture --dry --once   ★ 离线全链路演示（零依赖、不联网、不发送）
 *   node takeover.mjs --dry --once             接真浏览器，只看不回，跑一轮
 *   node takeover.mjs --dry                    挂机只看不回
 *   node takeover.mjs                          按 config.json 正式跑（默认仍然是全关）
 *   node takeover.mjs --pending                看待审草稿
 *   node takeover.mjs --approve <id>           人工放行一条
 *   node takeover.mjs --reject  <id>           丢弃一条
 *   node takeover.mjs --config <path>          指定配置文件
 *
 * 链路：inbox → video → brain → policy → actions → audit
 * 所有相对路径以 standalone/ 为基准，见 src/config.mjs。
 */
import { parseArgs } from 'node:util';
import { loadConfig } from './src/config.mjs';
import { initState, SeenStore, Audit, Approvals, VideoCache } from './src/state.mjs';
import { poll } from './src/inbox.mjs';
import { understand } from './src/video.mjs';
import { decide } from './src/brain.mjs';
import { precheck, evaluate } from './src/policy.mjs';
import { handle, approve, reject } from './src/actions.mjs';
import { startConsole, stopConsole } from './src/console.mjs';
import { closeBrowser, StopSignal } from './src/browser.mjs';
import { log, setLogFile, sleep, redact, truncate } from './src/util.mjs';

const USAGE = `
dsh-douyin-takeover —— 默认全关 / dry-run / 人工放行

用法：
  node takeover.mjs [选项]

选项：
  --fixture          离线假消息 + 假模型 + 假视频摘要（不碰浏览器、不联网、不发送）
  --dry              强制 dryRun：不点发送按钮，只写审计
  --once             只跑一轮就退出（适合验活 / 定时任务）
  --pending          列出待审草稿并退出
  --approve <id>     人工放行一条待审草稿
  --reject  <id>     丢弃一条待审草稿
  --config <path>    指定配置文件（默认 standalone/config.json，回退到模板）
  -h, --help         显示本帮助

环境变量（优先级高于配置文件）：
  DOUYIN_LLM_API_KEY / DOUYIN_ASR_API_KEY / DOUYIN_CONSOLE_TOKEN

推荐顺序：
  1) node takeover.mjs --fixture --dry --once
  2) node tools/verify.mjs && node tools/capture-selectors.mjs
  3) node takeover.mjs --dry --once
  4) 开 reply.enabled + 白名单 + requireHumanApproval，用 --pending / --approve 逐条放行
`;

function parseCli() {
  try {
    return parseArgs({
      options: {
        fixture: { type: 'boolean', default: false },
        dry: { type: 'boolean', default: false },
        once: { type: 'boolean', default: false },
        pending: { type: 'boolean', default: false },
        approve: { type: 'string' },
        reject: { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (e) {
    console.error(`参数错误：${e.message}\n${USAGE}`);
    process.exit(2);
  }
}

function buildDeps(cfg, paths) {
  initState(paths);
  setLogFile(paths.log);
  return {
    audit: new Audit(paths),
    approvals: new Approvals(paths, cfg.reply.approvalTtlHours),
    seen: new SeenStore(paths, cfg.reply.dedupeTtlHours),
    cache: new VideoCache(paths, cfg.video.cacheTtlHours),
  };
}

function printHeader(cfg, paths, configSource) {
  log('info', '=== dsh-douyin-takeover 启动 ===', {
    config: truncate(configSource, 90),
    node: process.version,
    fixture: !!cfg.douyin.useFixture,
    llmMock: !!cfg.llm.mock,
    video: !!cfg.video.enabled,
    replyEnabled: !!cfg.reply.enabled,
    dryRun: !!cfg.reply.dryRun,
    humanApproval: !!cfg.reply.requireHumanApproval,
    console: !!cfg.console.enabled,
  });
  if (cfg.demo) {
    log('warn', '离线演示模式：假消息 + 假模型 + 假视频摘要；不会打开浏览器、不会发任何请求、不会发送');
  }
  if (!cfg.reply.enabled && !cfg.demo) {
    log('warn', 'reply.enabled=false：本轮只生成草稿 / 进待审队列，不会真正发送');
  }
  if (cfg.reply.dryRun) {
    log('warn', 'dryRun=true：即使判定为 send，也只写 kind=dry 审计，不点发送按钮');
  }
  if (cfg.reply.requireHumanApproval) {
    log('info', '人工放行已开：用 node takeover.mjs --pending 查看，--approve <id> 放行');
  }
}

function printPending(approvals, cfg) {
  const rows = approvals.pending();
  if (!rows.length) { console.log('（待审队列为空）'); return; }
  console.log(`待审草稿 ${rows.length} 条（过期时间 ${cfg.reply.approvalTtlHours}h）：\n`);
  console.log('ID                 渠道      用户            原因                  草稿');
  console.log('-'.repeat(110));
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(18)} ${String(r.channel).padEnd(8)} ${String(r.userName || r.userId).slice(0, 14).padEnd(15)} ${String(r.reason).slice(0, 20).padEnd(21)} ${redact((r.texts || []).join(' | ')).slice(0, 60)}`,
    );
  }
  console.log(`\n放行：node takeover.mjs --approve <id>    丢弃：node takeover.mjs --reject <id>`);
}

async function runOnce(cfg, paths, deps) {
  const { audit, approvals, seen, cache } = deps;
  let items = [];
  try {
    items = await poll(cfg, paths);
  } catch (e) {
    if (e instanceof StopSignal) throw e;
    log('error', '轮询失败', { error: e.message });
    audit.write('error', { reason: 'poll-failed', error: e.message.slice(0, 200) });
    return;
  }
  log('info', `本轮读到 ${items.length} 条`, { source: cfg.douyin.useFixture ? 'fixture' : 'dom' });

  const history = [];
  let fresh = 0;
  for (const item of items) {
    if (seen.has(item.id)) continue; // 重启不重复处理
    fresh += 1;
    audit.write('polled', {
      channel: item.channel, itemId: item.id, userId: item.userId,
      userName: item.userName, text: truncate(item.text, 200),
    });

    const pre = precheck(cfg, item, audit);
    if (!pre.allowed) {
      audit.write('skipped', { channel: item.channel, itemId: item.id, userId: item.userId, reason: pre.reason });
      log('info', '跳过', { itemId: item.id, channel: item.channel, reason: pre.reason, text: truncate(item.text, 40) });
      seen.mark(item.id);
      history.push(item);
      continue;
    }

    const summary = await understand(cfg, paths, cache, item);
    if (summary) log('info', '视频摘要', { videoId: item.videoId, source: summary.source, summary: truncate(summary.summary, 80) });

    const draft = await decide(cfg, paths, item, summary, history.slice(-(Number(cfg.persona.historyItems) || 6)));
    const verdict = evaluate(cfg, draft, item, summary, audit);
    const result = await handle(cfg, paths, deps, { item, draft, verdict });
    log('info', '决策', {
      itemId: item.id, channel: item.channel, decision: verdict.decision,
      reason: verdict.reason, action: result.action, texts: draft.texts.map(redact),
    });
    seen.mark(item.id);
    history.push(item);
  }
  seen.save();
  log('info', '本轮完成', { read: items.length, fresh, pending: approvals.pending().length, counts: audit.countByKind() });
}

async function main() {
  const values = parseCli();
  if (values.help) { console.log(USAGE); return; }

  const { cfg, paths, configSource } = loadConfig({
    fixture: values.fixture,
    dry: values.dry,
    once: values.once,
    config: values.config,
  });
  const deps = buildDeps(cfg, paths);
  printHeader(cfg, paths, configSource);

  // ---- 一次性命令 ----
  if (values.pending) { printPending(deps.approvals, cfg); return; }
  if (values.reject) {
    const r = reject(deps, values.reject);
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    return;
  }
  if (values.approve) {
    const r = await approve(cfg, paths, deps, values.approve);
    console.log(`${r.ok ? '✓' : '✗'} ${r.message}`);
    await closeBrowser();
    return;
  }

  // ---- 主循环 ----
  const server = startConsole(cfg, deps);
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    log('info', `收到 ${sig}，收尾中…`);
    stopConsole(server);
    closeBrowser().catch(() => {});
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const once = !!(cfg.once || values.once);
  while (!stopping) {
    try {
      await runOnce(cfg, paths, deps);
    } catch (e) {
      if (e instanceof StopSignal) {
        log('error', '停机信号，立即停止（不重试、不换号、不绕过）', { signal: e.signal });
        deps.audit.write('error', { reason: 'stop-signal', signal: e.signal });
        break;
      }
      log('error', '本轮异常', { error: e.message });
      deps.audit.write('error', { reason: 'loop-exception', error: e.message.slice(0, 200) });
    }
    if (once || stopping) break;
    log('info', `等待 ${cfg.douyin.pollIntervalMs}ms 后下一轮`, { pending: deps.approvals.pending().length });
    await sleep(cfg.douyin.pollIntervalMs);
  }

  stopConsole(server);
  await closeBrowser();
  log('info', '=== 结束 ===', { counts: deps.audit.countByKind(), pending: deps.approvals.pending().length, log: paths.log });
  console.log(`\n下一步：node takeover.mjs --pending    （看待审草稿）`);
  console.log(`审计：${paths.audit}`);
}

main().catch((e) => {
  console.error(`致命错误：${e.stack || e.message}`);
  process.exit(1);
});
