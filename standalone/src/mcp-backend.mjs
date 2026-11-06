/**
 * mcp-backend.mjs —— 把 douyin-mcp 的能力层映射成本项目的统一对象
 *
 * 借鉴 [kdcadmin/dsh_douyin_tools](https://github.com/kdcadmin/dsh_douyin_tools) 的 vendor/douyin-mcp：
 * 它已经解决了「从页面自身 XHR 里取数据、DOM 只做兜底、取不到就如实返回空」这些真问题，
 * 本项目的价值在它前面的四道闸 + 审计 + 人工放行，不在重复实现抓包。
 *
 * 上游返回约定（务必照此判定，不要猜）：
 *   {ok:true, ...}                                   成功
 *   {ok:false, needLogin:true, hint}                 未登录 → 停机
 *   {ok:false, error:"...", status?}                 失败 → 本条跳过；命中频繁提示 → 停机
 *   {ok:true, verified:false, status:"pending"}      写动作未确认 → 不重复发，保留额度
 */
import { log, nowIso, truncate, sha256 } from './util.mjs';
import { StopSignal } from './browser.mjs';

const RATE_HINTS = ['操作过于频繁', '操作太快', '稍后再试', '频繁', 'rate limit', 'too many'];

function classifyFailure(res) {
  const blob = `${res?.error ?? ''} ${res?.hint ?? ''} ${res?.message ?? ''}`;
  if (RATE_HINTS.some((k) => blob.includes(k))) return 'rateLimit';
  return null;
}

/** 未登录 / 风控 → 抛停机信号；其它失败 → 返回 false 让本条跳过 */
function assertUsable(res, what) {
  if (!res) throw new Error(`${what}：MCP 返回空`);
  if (res.ok) return true;
  if (res.needLogin) throw new StopSignal('loginExpired', res.hint || `${what} 需要登录`);
  const sig = classifyFailure(res);
  if (sig) throw new StopSignal(sig, `${what}: ${truncate(res.error ?? res.hint, 120)}`);
  log('warn', `${what} 未成功，跳过`, { error: truncate(res.error ?? res.hint ?? res.status ?? 'unknown', 160) });
  return false;
}

function baseId(prefix, parts) {
  return `${prefix}:${parts.filter(Boolean).join(':')}`;
}

/** 一条评论 → 统一消息对象 */
function normalizeComment(post, c) {
  const text = String(c.text ?? '').trim();
  const cid = String(c.cid ?? '');
  const awemeId = String(post.aweme_id ?? c.aweme_id ?? '');
  return {
    id: baseId('cmt', [awemeId, cid || sha256(text).slice(0, 12)]),
    channel: 'comment',
    userId: String(c.user || 'unknown'),
    userName: String(c.user || 'unknown'),
    text,
    videoId: awemeId,
    timestamp: c.time || nowIso(),
    itemUrl: `https://www.douyin.com/video/${awemeId}`,
    isOwn: true,
    ref: { awemeId, cid, postTitle: post.title || '' },
    kind: c.kind || 'text',
    media: Array.isArray(c.media) ? c.media : [],
  };
}

/** 一条私信 → 统一消息对象（只收 inbound，上游已保证） */
function normalizeDm(row) {
  const name = String(row.name ?? row.nickname ?? row.userName ?? '').trim();
  const mid = String(row.messageId ?? '');
  const text = String(row.text ?? '').trim();
  return {
    id: baseId('dm', [name || row.peerId || row.conversationId || 'unknown', mid || sha256(text).slice(0, 12)]),
    channel: 'dm',
    userId: String(row.peerId || row.conversationId || name || 'unknown'),
    userName: name || String(row.peerId || 'unknown'),
    text,
    videoId: String(row.awemeId || ''),
    timestamp: row.time || nowIso(),
    itemUrl: '',
    isOwn: false,
    ref: { nickname: name, peerId: row.peerId || '', conversationId: row.conversationId || '', messageId: mid },
    kind: row.kind || 'text',
    media: Array.isArray(row.media) ? row.media : [],
    idSource: row.idSource || '',
  };
}

/** 从去重账本里还原「这条作品已经处理过哪些 cid」，交给上游直接过滤，省 token */
function cidsFor(seen, awemeId) {
  if (!seen?.data) return [];
  const prefix = `cmt:${awemeId}:`;
  return Object.keys(seen.data).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** 轮询：本人作品下的新评论 + 入站私信 */
export async function pollItems(cfg, client, seen) {
  const items = [];
  const notes = [];
  const m = cfg.mcp || {};
  const wantComments = cfg.inbox.comments || cfg.inbox.mentions;
  const wantDms = cfg.inbox.directMessages;

  if (wantComments) {
    const posts = await client.call('douyin_my_posts', { days: Number(m.myPostsDays) || 1 }, 120000);
    if (assertUsable(posts, 'douyin_my_posts')) {
      const list = (posts.items || []).slice(0, Number(m.maxPostsPerPoll) || 5);
      notes.push(`本人作品 ${posts.count ?? list.length} 条，本轮取 ${list.length} 条`);
      for (const p of list) {
        const exclude = cidsFor(seen, p.aweme_id).slice(0, Number(m.maxExcludeCids) || 300);
        const res = await client.call('douyin_comments', {
          aweme_id: p.aweme_id,
          num: Number(m.commentsPerPost) || 20,
          compact: true,
          exclude_cids: exclude,
        }, 90000);
        if (!assertUsable(res, `douyin_comments(${p.aweme_id})`)) continue;
        const got = (res.items || []).map((c) => normalizeComment(p, c)).filter((i) => i.text);
        notes.push(`作品 ${p.aweme_id} 新评论 ${got.length} 条`);
        items.push(...got);
      }
    }
  }

  if (wantDms) {
    const res = await client.call('douyin_inbox', { limit: Number(m.inboxLimit) || 12 }, 120000);
    if (assertUsable(res, 'douyin_inbox')) {
      const got = (res.items || []).map(normalizeDm).filter((i) => i.text);
      notes.push(`入站私信 ${got.length} 条`);
      items.push(...got);
    }
  }

  const limit = Number(cfg.douyin.maxItemsPerPoll) || 20;
  const out = items.slice(0, limit);
  if (out.length !== items.length) notes.push(`本轮截断到 ${limit} 条`);
  for (const n of notes) log('info', `[mcp] ${n}`);
  return out;
}

/**
 * 视频取材：元数据 + 封面/缩略图（交给 video.mjs 走视觉模型）+ 可选转写。
 * 返回 null 表示这条没有可看的视频。
 */
export async function gatherVideoInput(cfg, client, item) {
  const awemeId = item.ref?.awemeId || item.videoId;
  if (!awemeId) return null;
  const out = { awemeId, meta: null, frameDataUrls: [], transcript: '', notes: [] };

  const info = await client.call('douyin_video', { aweme_id: awemeId }, 60000);
  if (info?.ok) {
    out.meta = {
      title: info.title || info.desc || '',
      author: info.author || '',
      digg: info.digg, commentCount: info.comment, share: info.share,
      durationMs: info.duration || 0,
      url: info.url || `https://www.douyin.com/video/${awemeId}`,
      publishTime: info.publish_time || '',
    };
  } else {
    out.notes.push(`视频信息未取得：${truncate(info?.error ?? info?.hint ?? 'unknown', 80)}`);
  }

  if (cfg.mcp?.useThumbForVision !== false) {
    const thumb = await client.call('douyin_thumb', { aweme_id: awemeId }, 60000);
    if (thumb?.ok && thumb.path) {
      try {
        const fs = await import('node:fs');
        const buf = fs.readFileSync(thumb.path);
        out.frameDataUrls.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
        out.notes.push(`缩略图 ${buf.length} bytes`);
      } catch (e) {
        out.notes.push(`缩略图读取失败：${e.message}`);
      }
    } else {
      out.notes.push(`缩略图未取得：${truncate(thumb?.error ?? thumb?.hint ?? 'unknown', 80)}`);
    }
  }

  if (cfg.mcp?.transcript) {
    const w = await client.call('douyin_watch', {
      aweme_id: awemeId, seconds: Number(cfg.mcp.transcriptSeconds) || 120,
      frames: Number(cfg.video.maxFrames) || 6,
    }, Number(cfg.mcp.transcriptTimeoutMs) || 600000);
    if (w?.ok) {
      out.transcript = String(w.transcript ?? w.text ?? '');
      if (Array.isArray(w.frames) && !out.frameDataUrls.length) out.frameDataUrls.push(...w.frames);
      out.notes.push(`转写 ${out.transcript.length} 字`);
    } else {
      out.notes.push(`转写跳过：${truncate(w?.error ?? w?.hint ?? 'unknown', 80)}`);
    }
  }
  return out;
}

/** 真发送：评论走 douyin_comment(reply_cid)，私信走 douyin_chat_send，并要求 verified 回执 */
export async function sendItem(cfg, client, item, text) {
  const m = cfg.mcp || {};
  if (item.channel === 'comment' || item.channel === 'mention') {
    const awemeId = item.ref?.awemeId || item.videoId;
    if (!awemeId) return { ok: false, error: '评论缺少 aweme_id，无法定位作品' };
    const args = { aweme_id: awemeId, text };
    if (item.ref?.cid) args.reply_cid = item.ref.cid;
    if (m.mentionOwner && item.userName) args.mention = String(item.userName).replace(/^@/, '');
    const res = await client.call('douyin_comment', args, 180000);
    if (res?.ok && res.verified === false) log('warn', '评论回执为 pending/unknown，不自动重发', { awemeId, status: res.status });
    if (m.verifyAfterSend !== false && res?.ok && item.ref?.cid) {
      const chk = await client.call('douyin_check_reply', {
        aweme_id: awemeId, parent_cid: item.ref.cid, text,
      }, 90000).catch(() => null);
      res.verifiedBy = chk?.found ? 'check_reply' : 'submit_only';
      if (!chk?.found) log('info', 'check_reply 暂未命中（评论索引有延迟），以提交回执为准', { cid: res.cid });
    }
    return res;
  }
  if (item.channel === 'dm') {
    const nickname = item.ref?.nickname || item.userName;
    if (!nickname) return { ok: false, error: '私信缺少对方昵称，拒绝发送（不猜收件人）' };
    const args = { nickname, text };
    if (item.ref?.peerId) args.peer_id = item.ref.peerId;
    return client.call('douyin_chat_send', args, 180000);
  }
  return { ok: false, error: `未知渠道 ${item.channel}` };
}

export async function checkCredential(client) {
  return client.call('douyin_check_credential', {}, 60000);
}

export async function loginQr(client) {
  return client.call('douyin_login_qr', {}, 90000);
}

export async function loginPoll(client) {
  return client.call('douyin_login_poll', {}, 45000);
}

export async function selfcheck(client) {
  return client.call('douyin_selfcheck', {}, 180000);
}
