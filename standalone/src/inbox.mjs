/**
 * inbox.mjs —— 轮询评论 / 私信 / @，产出统一的消息对象。
 *
 * 统一对象：
 *   { id, channel:'comment'|'dm'|'mention', userId, userName, text,
 *     videoId, timestamp, itemUrl, isOwn }
 *
 * fixture 模式：读 fixtures/inbox-sample.json，不碰浏览器、不联网。
 * 真机模式：只在已登录页面里读 DOM；读到 0 条是安全的失败，不猜、不补。
 */
import fs from 'node:fs';
import { log, nowIso, sha256 } from './util.mjs';
import { openUrl, checkSignals } from './browser.mjs';
import { loadSelectors } from './selectors.mjs';

/** 把一条原始记录规范成统一对象，并生成稳定去重 id */
function normalize(raw, channel) {
  const text = String(raw.text ?? '').trim();
  const userId = String(raw.userId ?? raw.userName ?? 'unknown');
  const stable = raw.id || `${channel}:${userId}:${sha256(text).slice(0, 12)}`;
  return {
    id: String(stable),
    channel,
    userId,
    userName: String(raw.userName ?? userId),
    text,
    videoId: raw.videoId ? String(raw.videoId) : '',
    timestamp: raw.timestamp || nowIso(),
    itemUrl: raw.itemUrl || '',
    isOwn: raw.isOwn !== false,
  };
}

function loadFixture(paths) {
  try {
    const data = JSON.parse(fs.readFileSync(paths.fixtureInbox, 'utf8'));
    const items = Array.isArray(data) ? data : (data.items || []);
    return items.map((r) => normalize(r, r.channel || 'comment'));
  } catch (e) {
    log('error', 'fixture 读取失败', { file: paths.fixtureInbox, error: e.message });
    return [];
  }
}

/** 在页面里按选择器读卡片；字段缺失就留空，绝不编造 */
async function readCards(page, sel) {
  return page.evaluate(({ cardSel, f }) => {
    const q = (root, s) => {
      if (!s) return null;
      try { return root.querySelector(s); } catch { return null; }
    };
    const nodes = [...document.querySelectorAll(cardSel)];
    return nodes.map((n, i) => {
      const pick = (s, attr) => {
        const el = q(n, s);
        if (!el) return '';
        return (el.getAttribute('data-text') || el.innerText || el.textContent || '').trim();
      };
      const link = q(n, f.videoLink);
      const href = link?.getAttribute('href') || '';
      const m = href.match(/\/video\/([A-Za-z0-9_-]+)/);
      return {
        id: n.getAttribute(f.idAttr) || n.getAttribute('data-id') || '',
        userId: (q(n, f.user)?.getAttribute(f.userIdAttr)) || n.getAttribute(f.userIdAttr) || '',
        userName: pick(f.user),
        text: pick(f.text),
        time: pick(f.time),
        itemUrl: href ? new URL(href, location.href).href : '',
        videoId: m ? m[1] : '',
        _ordinal: i,
      };
    });
  }, { cardSel: sel.card, f: sel });
}

async function readReal(cfg, paths) {
  const sel = loadSelectors();
  const out = [];
  const channels = [
    ['comment', cfg.inbox.comments, cfg.douyin.commentInboxUrl, sel.comment],
    ['dm', cfg.inbox.directMessages, cfg.douyin.dmInboxUrl, sel.dm],
  ];
  for (const [channel, enabled, url, oneSel] of channels) {
    if (!enabled || !url) continue;
    const page = await openUrl(cfg, paths, url);
    await checkSignals(cfg, page);
    const rows = await readCards(page, oneSel);
    log('info', `读取 ${channel} 卡片`, { count: rows.length, url });
    for (const r of rows) {
      if (!r.text) continue; // 空文本不动，避免误发
      out.push(normalize({
        id: r.id || `${channel}:${r._ordinal}:${sha256(r.text).slice(0, 10)}`,
        userId: r.userId || `dom-${r._ordinal}`,
        userName: r.userName,
        text: r.text,
        videoId: r.videoId,
        itemUrl: r.itemUrl,
        timestamp: r.time || nowIso(),
      }, channel));
    }
  }
  return out;
}

/** @returns {Promise<Array>} 已规范化、可能重复（去重由 takeover 主循环做） */
export async function poll(cfg, paths) {
  const items = cfg.douyin.useFixture ? loadFixture(paths) : await readReal(cfg, paths);
  const limit = Number(cfg.douyin.maxItemsPerPoll) || 20;
  return items.slice(0, limit);
}
