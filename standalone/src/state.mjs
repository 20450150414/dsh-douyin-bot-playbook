/**
 * state.mjs —— 四个本地账本：去重 / 审计 / 待审队列 / 视频缓存。
 * 全部落在 standalone/state/（.gitignore 已排除）。重启不丢，因此可以安全中断。
 */
import fs from 'node:fs';
import {
  ensureDir, readJson, writeJson, appendJsonl, readJsonl, nowIso, shortId,
} from './util.mjs';

export function initState(paths) {
  ensureDir(paths.stateDir);
  // JSON 类账本不存在就落成空对象；JSONL 类文件不存在即为空
  for (const f of [paths.seen, paths.videoCache]) {
    try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { writeJson(f, {}); }
  }
}

/* ---------------- 去重账本 ---------------- */
export class SeenStore {
  constructor(paths, ttlHours = 48) {
    this.file = paths.seen;
    this.ttlMs = (Number(ttlHours) || 48) * 3600_000;
    this.data = readJson(this.file, {}) || {};
  }
  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, ts] of Object.entries(this.data)) {
      if (Number(ts) < cutoff) delete this.data[k];
    }
  }
  has(id) { return Object.prototype.hasOwnProperty.call(this.data, id); }
  mark(id, ts = Date.now()) { this.data[id] = ts; }
  save() { this.prune(); writeJson(this.file, this.data); }
  count() { return Object.keys(this.data).length; }
}

/* ---------------- 审计日志 ---------------- */
export class Audit {
  constructor(paths) { this.file = paths.audit; }
  write(kind, fields = {}) {
    const rec = { ts: nowIso(), kind, ...fields };
    appendJsonl(this.file, rec);
    return rec;
  }
  all() { return readJsonl(this.file); }
  tail(n = 30) { return this.all().slice(-n); }
  /** 最近 windowMs 内真正发出的条数（dry / queued / blocked 都不算） */
  sentSince(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this.all().filter((r) => r.kind === 'sent' && Date.parse(r.ts) >= cutoff);
  }
  lastSentAt() {
    const sent = this.all().filter((r) => r.kind === 'sent');
    return sent.length ? Date.parse(sent[sent.length - 1].ts) : 0;
  }
  /** 某条 item 已经真正回了几条 */
  repliesForItem(itemId) {
    return this.all().filter((r) => r.kind === 'sent' && r.itemId === itemId).length;
  }
  countByKind() {
    const out = {};
    for (const r of this.all()) out[r.kind] = (out[r.kind] || 0) + 1;
    return out;
  }
}

/* ---------------- 待审队列（append-only + fold） ----------------
 * 每条记录形如：
 *   { id, status:'pending'|'approved'|'sent'|'rejected'|'expired', ts, ... }
 * 同一个 id 的最后一条状态即当前状态。初始 pending 记录里带 item / texts / reason。
 */
export class Approvals {
  constructor(paths, ttlHours = 24) {
    this.file = paths.approval;
    this.ttlMs = (Number(ttlHours) || 24) * 3600_000;
  }
  _fold() {
    const byId = new Map();
    for (const r of readJsonl(this.file)) {
      const prev = byId.get(r.id) || {};
      byId.set(r.id, { ...prev, ...r });
    }
    return byId;
  }
  list(status = null) {
    const rows = [...this._fold().values()];
    return status ? rows.filter((r) => r.status === status) : rows;
  }
  find(id) { return this._fold().get(id) || null; }
  queue(item, texts, reason, decision = 'queue') {
    const id = shortId('ap');
    const rec = {
      id, status: 'pending', decision, ts: nowIso(),
      channel: item.channel, itemId: item.id, userId: item.userId,
      userName: item.userName, texts, reason,
      item: { id: item.id, channel: item.channel, text: item.text, itemUrl: item.itemUrl || '', videoId: item.videoId || '' },
    };
    appendJsonl(this.file, rec);
    return rec;
  }
  setStatus(id, status, extra = {}) {
    appendJsonl(this.file, { id, status, ts: nowIso(), ...extra });
  }
  isExpired(rec) {
    return Date.now() - Date.parse(rec.ts) > this.ttlMs;
  }
  pending() {
    return this.list('pending').filter((r) => !this.isExpired(r));
  }
}

/* ---------------- 视频理解缓存 ---------------- */
export class VideoCache {
  constructor(paths, ttlHours = 168) {
    this.file = paths.videoCache;
    this.ttlMs = (Number(ttlHours) || 168) * 3600_000;
    this.data = readJson(this.file, {}) || {};
  }
  get(videoId) {
    const hit = this.data[videoId];
    if (!hit) return null;
    if (Date.now() - Date.parse(hit.cachedAt || 0) > this.ttlMs) return null;
    return hit.summary;
  }
  set(videoId, summary) {
    this.data[videoId] = { cachedAt: nowIso(), summary };
    writeJson(this.file, this.data);
  }
  count() { return Object.keys(this.data).length; }
}
