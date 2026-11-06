/**
 * selectors.mjs —— 页面选择器「观察记录」
 *
 * ⚠️⚠️⚠️ 重要：下面这些字符串不是稳定契约，只是某次 DOM 观察的快照。
 * 抖音创作者中心 / 消息页改版后，--dry 会读到 0 条 —— 那是**安全的失败**，
 * 脚本不会瞎猜着往外发。改版后请跑：
 *
 *     node tools/capture-selectors.mjs            （真浏览器，导出 DOM 快照）
 *     node tools/capture-selectors.mjs --from-file state/dom-dump-xxx.html
 *
 * 然后照着 state/selector-candidates.json 改本文件，或写一份
 * standalone/selectors.local.json（不会被 git 跟踪）覆盖，见 mergeSelectors()。
 *
 * 原则：只放选择器，不放业务逻辑；只做读取，不做签名伪造 / 接口重放。
 */
import fs from 'node:fs';
import { resolveFromBase } from './config.mjs';

export const SELECTOR_VERSION = '2026-11-06-observed';

export const SELECTORS = {
  // 创作者中心「评论管理」列表
  comment: {
    list: '[data-e2e="comment-list"], [class*="comment-list"]',
    card: '[data-e2e="comment-item"], [class*="comment-item"], [class*="commentItem"]',
    idAttr: 'data-comment-id',
    user: '[data-e2e="comment-user"], [class*="user-name"], [class*="nickname"]',
    userIdAttr: 'data-user-id',
    text: '[data-e2e="comment-content"], [class*="comment-content"], [class*="content-text"]',
    time: '[class*="comment-time"], [class*="time"]',
    videoLink: 'a[href*="/video/"]',
    replyButton: 'button:has-text("回复"), [data-e2e="reply-btn"], [class*="reply-btn"]',
    replyInput: 'textarea, [contenteditable="true"], input[placeholder*="回复"]',
    submitButton: 'button:has-text("发送"), button:has-text("发布"), [data-e2e="submit-reply"]',
  },
  // 站内私信列表
  dm: {
    list: '[data-e2e="chat-list"], [class*="message-list"], [class*="conversation-list"]',
    card: '[data-e2e="chat-item"], [class*="chat-item"], [class*="conversation-item"]',
    idAttr: 'data-msg-id',
    user: '[class*="chat-name"], [class*="user-name"]',
    userIdAttr: 'data-user-id',
    text: '[class*="last-message"], [class*="message-text"], [class*="msg-content"]',
    time: '[class*="time"]',
    videoLink: 'a[href*="/video/"]',
    replyButton: '[class*="chat-item"], [data-e2e="chat-item"]',
    replyInput: 'textarea, [contenteditable="true"], [class*="input-area"] [contenteditable]',
    submitButton: 'button:has-text("发送"), [data-e2e="send-btn"], [class*="send-btn"]',
  },
  // 页面级异常信号（检测到就停机，不重试、不绕过）
  signals: {
    loginExpired: ['请登录', '登录后查看', '扫码登录', '登录已失效', '重新登录'],
    captcha: ['验证码', '安全验证', '请完成验证', '滑块验证', 'captcha'],
    rateLimit: ['操作过于频繁', '操作太快', '稍后再试', '频繁操作', '请稍候'],
  },
  media: {
    video: 'video',
    cover: '[class*="cover"] img, [data-e2e="video-cover"]',
    title: '[class*="video-title"], [data-e2e="video-title"], h1',
  },
};

/** 与本地覆盖文件（selectors.local.json）做浅层深合并 */
export function mergeSelectors(overrides) {
  if (!overrides || typeof overrides !== 'object') return SELECTORS;
  const out = { ...SELECTORS };
  for (const [group, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[group] = { ...(SELECTORS[group] || {}), ...value };
    } else {
      out[group] = value;
    }
  }
  return out;
}

/** 读取可选的本地覆盖（不存在则返回原表） */
export function loadSelectors() {
  const local = resolveFromBase('./selectors.local.json');
  try {
    return mergeSelectors(JSON.parse(fs.readFileSync(local, 'utf8')));
  } catch {
    return SELECTORS;
  }
}
