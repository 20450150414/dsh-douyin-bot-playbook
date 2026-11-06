/**
 * actions.mjs —— 决策落地：写审计 / 进待审队列 / 真正发送。
 *
 * 铁律：
 *  - dryRun=true 时**连发送按钮都不点**，只写 kind=dry 审计。
 *  - 真发送只在 decision='send' 且放行全绿时发生。
 *  - 人工 --approve 会重新跑一遍频率/密钥检查，过期草稿直接作废。
 *  - 每条动作都有 audit.jsonl 记录，可回放。
 */
import { log, sleep, nowIso, redact } from './util.mjs';
import { openUrl, checkSignals, StopSignal } from './browser.mjs';
import { loadSelectors } from './selectors.mjs';
import { evaluate } from './policy.mjs';

/** 在页面里定位这条消息并回复（best-effort，改版后 selectors.mjs 要更新） */
async function sendOne(cfg, paths, item, text) {
  const sel = loadSelectors();
  const one = item.channel === 'dm' ? sel.dm : sel.comment;
  const url = item.itemUrl
    || (item.channel === 'dm' ? cfg.douyin.dmInboxUrl : cfg.douyin.commentInboxUrl);
  const page = await openUrl(cfg, paths, url);
  await checkSignals(cfg, page);

  // 用文本前缀 + 昵称在卡片里找目标；找不到就抛错，绝不随便点第一个
  const needle = (item.text || '').slice(0, 18);
  const clicked = await page.evaluate(({ cardSel, f, needle, userName }) => {
    const cards = [...document.querySelectorAll(cardSel)];
    const hit = cards.find((c) => {
      const body = c.innerText || '';
      return (needle && body.includes(needle)) || (userName && body.includes(userName));
    });
    if (!hit) return false;
    const btn = hit.querySelector(f.replyButton);
    if (btn) { btn.click(); return true; }
    hit.click();
    return true;
  }, { cardSel: one.card, f: one, needle, userName: item.userName || '' });
  if (!clicked) throw new Error(`页面上找不到目标消息卡片（itemId=${item.id}）`);

  await sleep(400);
  const input = page.locator(one.replyInput).first();
  await input.waitFor({ state: 'visible', timeout: 8000 });
  await input.fill(text);
  await sleep(300);
  await page.locator(one.submitButton).first().click();
  await sleep(600);
  await checkSignals(cfg, page);
}

/** 真正发送（多条之间留 1~3 秒，模拟人手） */
async function actuallySend(cfg, paths, item, texts, audit, { approvedBy = 'auto' } = {}) {
  let sent = 0;
  for (const [i, t] of texts.entries()) {
    try {
      await sendOne(cfg, paths, item, t);
      sent += 1;
      audit.write('sent', {
        channel: item.channel, itemId: item.id, userId: item.userId,
        text: t, decision: approvedBy, messageCount: texts.length, index: i,
      });
      log('info', '已发送', { channel: item.channel, itemId: item.id, text: redact(t) });
      if (i < texts.length - 1) await sleep(1200 + (i % 2) * 800);
    } catch (e) {
      audit.write('error', {
        channel: item.channel, itemId: item.id, text: t,
        reason: 'send-failed', error: e.message.slice(0, 200),
      });
      log('error', '发送失败，停止该条剩余消息', { itemId: item.id, error: e.message });
      if (e instanceof StopSignal) throw e; // 风控/登录信号 → 主循环停机
      break;
    }
  }
  return sent;
}

/** 主循环里的落地 */
export async function handle(cfg, paths, deps, ctx) {
  const { item, draft, verdict } = ctx;
  const { audit, approvals } = deps;
  const base = {
    channel: item.channel, itemId: item.id, userId: item.userId,
    reason: verdict.reason, model: draft.model || '',
  };

  switch (verdict.decision) {
    case 'silent':
      audit.write('skipped', { ...base, text: '', reason: verdict.reason });
      return { action: 'silent' };

    case 'block':
      audit.write('blocked', { ...base, text: draft.texts.join(' | ') });
      log('warn', '整条拦截', { reason: verdict.reason, itemId: item.id });
      return { action: 'block' };

    case 'queue': {
      const rec = approvals.queue(item, draft.texts, verdict.reason, verdict.decision);
      audit.write('queued', { ...base, approvalId: rec.id, text: draft.texts.join(' | '), forced: !!verdict.forced });
      log('info', '进入待审队列', { approvalId: rec.id, reason: verdict.reason });
      return { action: 'queue', approvalId: rec.id };
    }

    case 'send': {
      if (cfg.reply.dryRun || verdict.dry) {
        audit.write('dry', { ...base, text: draft.texts.join(' | '), reason: 'dry-run' });
        log('info', '[DRY] 本应发送，已按 dry-run 跳过', { itemId: item.id, text: redact(draft.texts.join(' | ')) });
        return { action: 'dry' };
      }
      const n = await actuallySend(cfg, paths, item, draft.texts, audit);
      return { action: 'sent', count: n };
    }

    default:
      audit.write('error', { ...base, reason: `unknown-decision:${verdict.decision}` });
      return { action: 'error' };
  }
}

/** --approve <id>：人工放行一条待审草稿 */
export async function approve(cfg, paths, deps, id) {
  const { audit, approvals } = deps;
  const rec = approvals.find(id);
  if (!rec) return { ok: false, message: `找不到待审记录 ${id}` };
  if (rec.status !== 'pending') return { ok: false, message: `状态已是 ${rec.status}，不重复处理` };
  if (approvals.isExpired(rec)) {
    approvals.setStatus(id, 'expired');
    audit.write('blocked', { itemId: rec.itemId, reason: 'approval-expired', approvalId: id });
    return { ok: false, message: `草稿已超过 ${cfg.reply.approvalTtlHours}h，作废（避免旧话今天突然发出去）` };
  }

  const item = {
    id: rec.itemId, channel: rec.channel, userId: rec.userId, userName: rec.userName,
    text: rec.item?.text || '', itemUrl: rec.item?.itemUrl || '', videoId: rec.item?.videoId || '',
  };
  if (!Array.isArray(rec.texts) || !rec.texts.length) {
    return { ok: false, message: '草稿没有可发送的文本' };
  }
  if (/injection-suspect/.test(rec.reason || '')) {
    log('warn', '该草稿源自注入嫌疑消息，人工明确批准后才放行', { approvalId: id, reason: rec.reason });
  }
  // 人工批准后再过一次密钥/长度/频率闸（注入类允许人工明确批准）
  const recheck = evaluate(cfg, { silent: false, texts: rec.texts, model: 'approved' }, item, null, audit);
  if (recheck.decision === 'block') {
    approvals.setStatus(id, 'rejected', { rejectReason: recheck.reason });
    audit.write('blocked', { itemId: rec.itemId, reason: `recheck:${recheck.reason}`, approvalId: id });
    return { ok: false, message: `复审拦截：${recheck.reason}` };
  }
  if (recheck.decision === 'queue' && /^rate-/.test(recheck.reason)) {
    return { ok: false, message: `频率闸未放行（${recheck.reason}），请稍后再批准` };
  }

  approvals.setStatus(id, 'approved', { approvedAt: nowIso() });
  if (cfg.reply.dryRun) {
    audit.write('dry', { itemId: rec.itemId, approvalId: id, text: rec.texts.join(' | '), reason: 'approved-but-dry-run' });
    approvals.setStatus(id, 'sent', { sentAt: nowIso(), dry: true });
    return { ok: true, message: `[DRY] 已批准但 dry-run 中，未真正发送；去掉 --dry 并设 reply.dryRun=false 才会发` };
  }
  const n = await actuallySend(cfg, paths, item, rec.texts, audit, { approvedBy: 'human' });
  if (n > 0) {
    approvals.setStatus(id, 'sent', { sentAt: nowIso() });
    audit.write('sent', { itemId: rec.itemId, approvalId: id, reason: 'human-approved', messageCount: n });
    return { ok: true, message: `已发送 ${n} 条` };
  }
  return { ok: false, message: '发送未成功，记录仍为 approved，可排查后再试' };
}

/** --reject <id> */
export function reject(deps, id) {
  const { approvals, audit } = deps;
  const rec = approvals.find(id);
  if (!rec || rec.status !== 'pending') return { ok: false, message: `记录 ${id} 不是 pending` };
  approvals.setStatus(id, 'rejected');
  audit.write('blocked', { itemId: rec.itemId, approvalId: id, reason: 'human-rejected' });
  return { ok: true, message: '已丢弃该草稿' };
}
