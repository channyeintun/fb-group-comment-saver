// Shared UI helpers for the side panel and the library page. See SPEC.md §8.
// Everything that renders user data goes through el() (textContent / setAttribute),
// never innerHTML.

import { listPosts, getPost, getComments, getAllComments } from '../lib/db.js';
import { buildJson, buildCsv, buildMarkdown, exportFileName } from '../lib/export.js';

// ---------------------------------------------------------------------------------------------
// DOM builder

/** Attributes assigned as DOM properties rather than via setAttribute. */
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'indeterminate', 'tabIndex']);
/** URL-valued attributes; values are passed through safeUrl() so data can never inject javascript: URLs. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster']);
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'chrome-extension:', 'mailto:']);

/**
 * Returns `value` if it is a URL with a safe protocol (http/https/blob/chrome-extension/mailto)
 * or a fragment link ("#…"); otherwise null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeUrl(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.startsWith('#')) return s;
  try {
    const u = new URL(s, globalThis.location?.href);
    return SAFE_PROTOCOLS.has(u.protocol) ? s : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Node|string|number|null|undefined|false|ElChild[]} ElChild
 */

/**
 * Tiny DOM builder.
 *   el('a', { class: 'link', href, target: '_blank', onclick: fn }, 'text', childNode, [more])
 * - strings/numbers become text nodes (never parsed as HTML); null/undefined/false are skipped;
 *   arrays are flattened.
 * - attrs: `class` (string or array), `dataset` (object), `style` (object, supports --custom-props,
 *   or string), `on<event>` (listener), `text` (textContent), boolean `true` → empty attribute,
 *   `null`/`undefined`/`false` → omitted. URL attributes are sanitised with safeUrl().
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...ElChild} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') {
        node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
      } else if (key === 'dataset') {
        for (const [k, v] of Object.entries(value)) if (v != null) node.dataset[k] = String(v);
      } else if (key === 'style' && typeof value === 'object') {
        for (const [prop, v] of Object.entries(value)) {
          if (v == null) continue;
          if (prop.startsWith('--')) node.style.setProperty(prop, String(v));
          else /** @type {any} */ (node.style)[prop] = v;
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (PROPS.has(key)) {
        /** @type {any} */ (node)[key] = value;
      } else if (URL_ATTRS.has(key)) {
        const safe = safeUrl(value);
        if (safe) node.setAttribute(key, safe);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

/** @param {Node} parent @param {ElChild[]} children */
function appendChildren(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const relativeShortFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const numberFormat = new Intl.NumberFormat();

/** @param {string|number|Date|null|undefined} iso */
function toTime(iso) {
  if (iso == null || iso === '') return NaN;
  return new Date(iso).getTime();
}

/**
 * Locale date + time ("14 Oct 2026, 18:23"); '—' for null/invalid.
 * @param {string|null|undefined} iso
 */
export function formatDate(iso) {
  const t = toTime(iso);
  return Number.isNaN(t) ? '—' : dateTimeFormat.format(t);
}

const REL_UNITS = /** @type {const} */ ([
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]);

/**
 * Relative time ("5 minutes ago", "yesterday", "just now"); '—' for null/invalid.
 * @param {string|null|undefined} iso
 * @param {number} [now]
 */
export function relTime(iso, now = Date.now()) {
  return formatRelative(relativeFormat, iso, now);
}

/**
 * Compact relative time ("12 min. ago") for tight spaces; '—' for null/invalid.
 * @param {string|null|undefined} iso
 * @param {number} [now]
 */
export function relTimeShort(iso, now = Date.now()) {
  return formatRelative(relativeShortFormat, iso, now);
}

/** @param {Intl.RelativeTimeFormat} fmt @param {string|null|undefined} iso @param {number} now */
function formatRelative(fmt, iso, now) {
  const t = toTime(iso);
  if (Number.isNaN(t)) return '—';
  const diffSec = (t - now) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  for (const [unit, secs] of REL_UNITS) {
    if (abs >= secs) return fmt.format(Math.round(diffSec / secs), unit);
  }
  return fmt.format(Math.round(diffSec / 60), 'minute');
}

/** @param {number|null|undefined} n */
export function formatNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? numberFormat.format(n) : '—';
}

/**
 * "1 comment" / "12 comments".
 * @param {number} n @param {string} singular @param {string} [pluralWord]
 */
export function plural(n, singular, pluralWord = `${singular}s`) {
  return `${formatNumber(n)} ${n === 1 ? singular : pluralWord}`;
}

/**
 * Elapsed duration "m:ss" or "h:mm:ss".
 * @param {number} ms
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ---------------------------------------------------------------------------------------------
// Misc helpers

/**
 * Debounces `fn`. The returned function has `.flush()` (run a pending call now and return its
 * result) and `.cancel()`.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & { flush: () => ReturnType<F>|undefined, cancel: () => void }}
 */
export function debounce(fn, ms) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {any[]|null} */
  let pendingArgs = null;
  /** @type {any} */
  let pendingThis;

  const run = () => {
    timer = null;
    const args = pendingArgs || [];
    pendingArgs = null;
    return fn.apply(pendingThis, args);
  };
  /** @this {any} */
  function debounced(...args) {
    pendingArgs = args;
    pendingThis = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }
  debounced.flush = () => {
    if (!timer) return undefined;
    clearTimeout(timer);
    return run();
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };
  return /** @type {any} */ (debounced);
}

/**
 * Triggers a download of `text` as `filename` (Blob + object URL + temporary <a download>).
 * @param {string} filename
 * @param {string} text
 * @param {string} [mime]
 */
export function downloadText(filename, text, mime = 'text/plain') {
  const type = /charset=/i.test(mime) ? mime : `${mime};charset=utf-8`;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some cases; give it time.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Shows a transient message in the page's toast region (created on demand; aria-live polite).
 * @param {string} message
 * @param {{ tone?: 'info'|'ok'|'warn'|'danger', timeout?: number }} [opts]
 */
export function showToast(message, { tone = 'info', timeout } = {}) {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = el('div', { id: 'toast-region', class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(region);
  }
  const toast = el('div', { class: `toast toast-${tone}` }, message);
  const dismiss = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
  };
  toast.addEventListener('click', dismiss);
  region.appendChild(toast);
  setTimeout(dismiss, timeout ?? (tone === 'danger' ? 8000 : 3500));
}

// ---------------------------------------------------------------------------------------------
// Export & navigation (shared by side panel and library)

/** @type {Record<'json'|'csv'|'md', string>} */
const EXPORT_MIME = { json: 'application/json', csv: 'text/csv', md: 'text/markdown' };

/**
 * Builds and downloads an export of the whole archive (postId omitted) or of one post.
 * @param {'json'|'csv'|'md'} kind
 * @param {string} [postId]
 * @returns {Promise<{ filename: string, posts: number, comments: number }>}
 */
export async function exportArchive(kind, postId) {
  if (!(kind in EXPORT_MIME)) throw new Error(`Unknown export format: ${kind}`);
  const now = new Date();
  const exportedAt = now.toISOString();
  let posts;
  let comments;
  if (postId) {
    const post = await getPost(postId);
    posts = post ? [post] : [];
    comments = post ? await getComments(postId) : [];
  } else {
    [posts, comments] = await Promise.all([listPosts(), getAllComments()]);
  }
  if (!posts.length) throw new Error('Nothing to export yet.');

  const text =
    kind === 'json'
      ? buildJson(posts, comments, { exportedAt })
      : kind === 'csv'
        ? buildCsv(posts, comments)
        : buildMarkdown(posts, comments, { exportedAt });
  const filename = exportFileName(kind, postId || 'all', now);
  downloadText(filename, text, EXPORT_MIME[kind]);
  return { filename, posts: posts.length, comments: comments.length };
}

/**
 * Opens the library page (focusing an already-open library tab), optionally deep-linked to a post.
 * @param {string} [postId]
 */
export async function openLibrary(postId) {
  const base = chrome.runtime.getURL('library.html');
  // The nonce makes every deep link a new fragment, so an open library fires hashchange even when
  // it already shows #post=<id> (e.g. while it lists search results). The library strips it.
  const url = postId ? `${base}#post=${encodeURIComponent(postId)}&t=${Date.now()}` : base;
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => (t.url || t.pendingUrl || '').startsWith(base));
    if (existing?.id != null) {
      // Only pass a url when deep-linking: re-setting the same URL would reload the page.
      await chrome.tabs.update(existing.id, postId ? { active: true, url } : { active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    // Fall through to opening a new tab.
  }
  await chrome.tabs.create({ url });
}
