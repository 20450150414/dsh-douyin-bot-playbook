/**
 * policy.mjs —— 「能不能发」的四道闸。这是整套东西里唯一决定放行的文件。
 *
 *   ① 开关/渠道闸    reply.enabled / replyToComments / replyToDMs / inbox.*
 *   ② 白名单/黑名单闸  whitelist（fail-closed）/ denylist
 *   ③ 频率闸          maxRepliesPerHour / Day / minIntervalSec / maxRepliesPerItem
 *   ④ 人工放行 + 审计  requireHumanApproval / injection 强制转人工 / secret 拦截
 *
 * 判定结果：
 *   precheck()  → { allowed, reason }          不过就不必调模型，省 token
 *   evaluate()  → { decision, reason, forced }
 *     decision: 'send' | 'queue' | 'block' | 'silent'
 *
 * ★ 离线演示（cfg.demo，仅 --fixture + dry-run）会旁路「开关 / 渠道 / 白名单」三闸，
 *   否则空白名单会把所有样例都拦掉、演示看不到链路。旁路会明确打日志，
 *   且绝不旁路：黑名单关键词、注入检测、密钥拦截、长度、频率、人工放行。
 *   真机模式一律 fail-closed。
 */
import { compilePatterns, matchesAny, log } from './util.mjs';

let _secret = null;
let _injection = null;
let _warned = false;

function patterns(cfg) {
  if (!_secret) {
    _secret = compilePatterns(cfg.safety.secretPatterns || []);
    _injection = compilePatterns(cfg.safety.injectionPatterns || []);
  }
  return { secret: _secret, injection: _injection };
}

/** 测试用：规则改了以后重置缓存 */
export function resetPatterns() { _secret = null; _injection = null; _warned = false; }

function demoRelax(cfg) {
  if (!cfg.demo) return false;
  if (!_warned) {
    log('warn', '[fixture] 离线演示已旁路「开关/渠道/白名单」闸（仅 dry-run、不联网、不发送）；黑名单/注入/密钥/频率/人工放行仍然生效');
    _warned = true;
  }
  return true;
}

function channelReadEnabled(cfg, channel) {
  if (channel === 'comment') return !!cfg.inbox.comments;
  if (channel === 'dm') return !!cfg.inbox.directMessages;
  if (channel === 'mention') return !!cfg.inbox.mentions;
  return false;
}

function channelReplyEnabled(cfg, channel) {
  if (channel === 'comment' || channel === 'mention') return !!cfg.reply.replyToComments;
  if (channel === 'dm') return !!cfg.reply.replyToDMs;
  return false;
}

/** ① ② 与 per-item 上限：不过就直接跳过，不调模型 */
export function precheck(cfg, item, audit) {
  const relaxed = demoRelax(cfg);

  if (!relaxed) {
    if (!channelReadEnabled(cfg, item.channel)) {
      return { allowed: false, reason: 'channel-not-read' };
    }
    if (!cfg.reply.enabled) {
      return { allowed: false, reason: 'reply-disabled' };
    }
    if (!channelReplyEnabled(cfg, item.channel)) {
      return { allowed: false, reason: 'reply-channel-disabled' };
    }
  }

  // 黑名单永远生效（演示也不旁路）
  const dl = cfg.reply.denylist || {};
  if ((dl.userIds || []).some((u) => String(u) === String(item.userId))) {
    return { allowed: false, reason: 'denylist-user' };
  }
  const denyKw = (dl.keywords || []).find((k) => k && item.text.includes(String(k)));
  if (denyKw) return { allowed: false, reason: `denylist-keyword:${denyKw}` };

  // 白名单 fail-closed
  if (!relaxed) {
    const wl = cfg.reply.whitelist || {};
    const users = wl.userIds || [];
    const keywords = wl.keywords || [];
    if (!users.length && !keywords.length && wl.allowAllWhenEmpty !== true) {
      return { allowed: false, reason: 'empty-whitelist' };
    }
    if (users.length || keywords.length) {
      const hitUser = users.some((u) => String(u) === String(item.userId) || String(u) === String(item.userName));
      const hitKw = keywords.some((k) => k && item.text.includes(String(k)));
      if (!hitUser && !hitKw) return { allowed: false, reason: 'not-in-whitelist' };
    }
  }

  const maxPerItem = Number(cfg.reply.maxRepliesPerItem) || 3;
  if (audit.repliesForItem(item.id) >= maxPerItem) {
    return { allowed: false, reason: 'max-replies-per-item' };
  }
  return { allowed: true, reason: 'ok' };
}

/** ③ ④ 内容级判定 */
export function evaluate(cfg, draft, item, summary, audit) {
  const { secret, injection } = patterns(cfg);

  if (draft.silent || !draft.texts?.length) {
    return { decision: 'silent', reason: 'silent' };
  }
  if (draft.error) {
    return { decision: 'silent', reason: `model-error:${draft.error.slice(0, 60)}` };
  }

  // 注入检测：正文 + 昵称 + 视频 OCR + 口播，全部只当被检测的文本
  const externalText = [
    item.text, item.userName,
    summary?.ocrText || '', summary?.transcript || '',
  ].join('\n');
  const injHit = matchesAny(injection, externalText);
  if (injHit) {
    // 命中注入 → 强制转人工，绝不自动发（即使关掉 requireHumanApproval）
    return { decision: 'queue', reason: `injection-suspect:${injHit}`, forced: true };
  }

  // 密钥 / 本机路径泄漏 → 整条拦截，不截断后发
  for (const t of draft.texts) {
    const leak = matchesAny(secret, t);
    if (leak) return { decision: 'block', reason: `secret-leak:${leak}` };
    if (t.length > (Number(cfg.reply.maxReplyChars) || 80)) {
      return { decision: 'block', reason: 'reply-too-long' };
    }
  }

  // 频率闸：只统计真正 sent 的记录（dry / queued / blocked 都不算）
  const hour = Number(cfg.reply.maxRepliesPerHour) || 8;
  const day = Number(cfg.reply.maxRepliesPerDay) || 40;
  const minGapMs = (Number(cfg.reply.minIntervalSec) || 30) * 1000;
  if (audit.sentSince(3600_000).length >= hour) {
    return { decision: 'queue', reason: 'rate-hour-exceeded' };
  }
  if (audit.sentSince(86400_000).length >= day) {
    return { decision: 'queue', reason: 'rate-day-exceeded' };
  }
  if (Date.now() - audit.lastSentAt() < minGapMs) {
    return { decision: 'queue', reason: 'rate-min-interval' };
  }

  if (cfg.reply.requireHumanApproval) {
    return { decision: 'queue', reason: 'human-approval' };
  }
  if (!cfg.demo && !cfg.reply.enabled) {
    return { decision: 'queue', reason: 'reply-disabled' };
  }
  return { decision: 'send', reason: 'ok', dry: !!cfg.reply.dryRun };
}
