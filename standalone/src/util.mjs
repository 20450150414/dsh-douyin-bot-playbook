/**
 * util.mjs —— 无依赖的小工具：日志、JSON / JSONL 读写、正则、文本处理。
 * 这里不放任何业务逻辑，方便单独测试。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

export function shortId(prefix = 'ap') {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写同目录临时文件再 rename，避免半截 JSON */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, record) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readJsonl(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行，不中断 */ }
  }
  return out;
}

/** 编译用户写的正则字符串；非法正则不会让进程崩，只返回 null 并记一条警告 */
export function compilePatterns(list = [], flags = 'i') {
  const out = [];
  for (const src of list) {
    if (typeof src !== 'string' || !src) continue;
    try { out.push({ source: src, re: new RegExp(src, flags) }); }
    catch { /* 忽略非法规则 */ }
  }
  return out;
}

export function matchesAny(compiled, text) {
  if (!text) return null;
  for (const { source, re } of compiled) {
    // 复用带 g 标志的正则前重置 lastIndex；这里统一用非 g，保险起见
    re.lastIndex = 0;
    if (re.test(text)) return source;
  }
  return null;
}

/** 把模型输出切成多条要发出的消息 */
export function splitReplies(raw, { maxChars = 80, maxItems = 3 } = {}) {
  if (raw == null) return { silent: true, texts: [], raw: '' };
  const text = String(raw).trim();
  if (!text) return { silent: true, texts: [], raw: text };
  if (/^\[SILENT\]$/i.test(text)) return { silent: true, texts: [], raw: text };

  let parts = text
    .replace(/\r/g, '')
    .split(/\s*\|\|\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 过滤明显的「汇报句」——模型把工具结果当正文写出来时，宁可不发
  const reportLike = /(已(经)?(回复|发送|处理)|message[_ ]?id|成功\s*[（(]|^\s*(已|完成)[：:])/i;
  parts = parts.filter((s) => !reportLike.test(s));

  const clean = [];
  for (const p of parts) {
    // 括号内心戏 / markdown 粗体，统一剥掉，避免发出去变成怪话
    const stripped = p
      .replace(/[（(][^）)]{0,40}[）)]/g, '')
      .replace(/\*\*|`|^#{1,3}\s*/g, '')
      .trim();
    if (stripped) clean.push(stripped);
  }
  const texts = clean.slice(0, maxItems).map((s) => (s.length > maxChars ? s : s));
  return { silent: texts.length === 0, texts, raw: text, truncated: clean.length > maxItems };
}

/** 日志：同时写控制台与 state/takeover.log */
let logFile = null;
export function setLogFile(file) {
  logFile = file;
}
export function log(level, msg, extra) {
  const line = `[${nowIso()}] [${String(level).toUpperCase()}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`;
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
  if (logFile) {
    try { fs.appendFileSync(logFile, `${line}\n`, 'utf8'); } catch { /* 日志失败不影响主流程 */ }
  }
}

/** 脱敏：把凭据/路径特征换成 <redacted>，用于日志与控制台展示 */
export function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(/sk-[A-Za-z0-9]{12,}/g, '<redacted:key>')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|password|token|cookie)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s"']{4,}/g, '<redacted:path>');
}

export function truncate(s, n = 120) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
