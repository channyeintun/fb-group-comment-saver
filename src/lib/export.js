// Archive exporters: JSON, CSV (RFC 4180) and Markdown. Pure — no DOM, no chrome.*. See SPEC.md §5.

import { EXPORT_FORMAT } from './constants.js';

/** @typedef {import('./normalize.js').PostRecord} PostRecord */
/** @typedef {import('./normalize.js').CommentRecord} CommentRecord */

export const CSV_COLUMNS = [
  'post_id', 'post_url', 'post_author', 'post_posted_at', 'post_text',
  'comment_id', 'parent_id', 'thread_id', 'depth', 'is_reply', 'reply_to',
  'author_name', 'author_id', 'author_url', 'text', 'created_at', 'created_at_text',
  'reaction_count', 'attachment_urls', 'permalink', 'first_saved_at', 'last_saved_at', 'missing_at',
];

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return value || new Date().toISOString();
}

function timeOf(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Posts newest first by postedAt; posts without a date last (then by lastSavedAt desc). */
function sortPosts(posts) {
  return [...(posts || [])].sort((a, b) => {
    const ta = timeOf(a.postedAt);
    const tb = timeOf(b.postedAt);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    return (timeOf(b.lastSavedAt) ?? 0) - (timeOf(a.lastSavedAt) ?? 0);
  });
}

function compareComments(a, b) {
  const byOrder = (a.order ?? 0) - (b.order ?? 0);
  if (byOrder) return byOrder;
  return (timeOf(a.createdAt) ?? 0) - (timeOf(b.createdAt) ?? 0);
}

/** postId → comments sorted by order (then createdAt). */
function groupComments(comments) {
  /** @type {Map<string, CommentRecord[]>} */
  const map = new Map();
  for (const c of comments || []) {
    if (!map.has(c.postId)) map.set(c.postId, []);
    map.get(c.postId).push(c);
  }
  for (const list of map.values()) list.sort(compareComments);
  return map;
}

/**
 * @param {PostRecord[]} posts
 * @param {CommentRecord[]} comments
 * @param {{exportedAt?: string|Date}} [opts]
 * @returns {string}
 */
export function buildJson(posts, comments, { exportedAt } = {}) {
  const byPost = groupComments(comments);
  const outPosts = sortPosts(posts).map((p) => ({ ...p, comments: byPost.get(p.id) || [] }));
  const commentCount = outPosts.reduce((n, p) => n + p.comments.length, 0);
  return JSON.stringify(
    { format: EXPORT_FORMAT, exportedAt: toIso(exportedAt), postCount: outPosts.length, commentCount, posts: outPosts },
    null,
    2,
  );
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Free-text cells (written by arbitrary Facebook users) that start with = + - @ or a tab/CR are
 * evaluated as formulas by Excel, LibreOffice and Google Sheets — "=HYPERLINK(…)" becomes a live
 * link, "+1" a number, "- item" an error. Such values get a leading apostrophe (OWASP CSV
 * injection guidance); spreadsheets then show the text as typed.
 */
function csvText(value) {
  if (value === null || value === undefined) return value;
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** CSV columns holding free text or URLs (neutralized with csvText); ids, numbers and ISO dates are not. */
const CSV_TEXT_COLUMNS = new Set([
  'post_url', 'post_author', 'post_text', 'reply_to', 'author_name', 'author_url', 'text',
  'created_at_text', 'attachment_urls', 'permalink',
]);

function attachmentUrls(attachments) {
  return (attachments || []).map((a) => a && (a.src || a.href)).filter(Boolean).join(' ');
}

function csvRow(post, c) {
  return [
    c.postId, post?.url, post?.authorName, post?.postedAt, post?.text,
    c.id, c.parentId, c.threadId, c.depth, c.isReply === undefined ? '' : String(!!c.isReply), c.replyToName,
    c.authorName, c.authorId, c.authorUrl, c.text, c.createdAt, c.createdAtText,
    c.reactionCount ?? 0, attachmentUrls(c.attachments), c.permalink, c.firstSavedAt, c.lastSavedAt, c.missingAt,
  ]
    .map((value, i) => csvField(CSV_TEXT_COLUMNS.has(CSV_COLUMNS[i]) ? csvText(value) : value))
    .join(',');
}

/**
 * One row per comment, UTF-8 BOM, CRLF line endings, RFC 4180 quoting. Free-text cells starting
 * with = + - @ (tab, CR) get a leading apostrophe so spreadsheets don't run them as formulas.
 * Id columns stay plain digits (exact for scripts); spreadsheets must import them as Text, since
 * Excel keeps only 15 significant digits of a number.
 * @param {PostRecord[]} posts
 * @param {CommentRecord[]} comments
 * @returns {string}
 */
export function buildCsv(posts, comments) {
  const byPost = groupComments(comments);
  const sorted = sortPosts(posts);
  const lines = [CSV_COLUMNS.join(',')];
  for (const post of sorted) {
    for (const c of byPost.get(post.id) || []) lines.push(csvRow(post, c));
    byPost.delete(post.id);
  }
  // Comments whose post record is missing are still exported (with empty post columns).
  for (const list of byPost.values()) for (const c of list) lines.push(csvRow(null, c));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Escapes characters that would change Markdown inline formatting of a short label. */
function mdInline(s) {
  return String(s).replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

function splitLines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
}

/** @typedef {{c: CommentRecord, children: ThreadNode[]}} ThreadNode */

/**
 * Reply trees of one post's comments, built from parentId (falling back to the thread root):
 * every comment becomes a node first, then each reply is attached to its parent wherever that
 * sorts — partial saves can give a new reply an order before its parent's. Children are sorted by
 * order, then createdAt. A reply whose parent is not stored (or that would close a cycle) is a root.
 * @param {CommentRecord[]} comments  one post's comments
 * @returns {ThreadNode[]} roots, sorted the same way
 */
export function buildThreads(comments) {
  /** @type {Map<string, ThreadNode>} */
  const nodes = new Map();
  for (const c of [...(comments || [])].sort(compareComments)) {
    if (!nodes.has(c.id)) nodes.set(c.id, { c, children: [] });
  }
  /** @param {CommentRecord} c */
  const parentOf = (c) => {
    let parent = c.parentId ? nodes.get(c.parentId) : undefined;
    if (!parent && c.isReply && c.threadId && c.threadId !== c.id) parent = nodes.get(c.threadId);
    return parent && parent.c.id !== c.id ? parent : undefined;
  };
  /** @type {ThreadNode[]} */
  const roots = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node.c);
    // Cycle guard: walking up from the parent must not come back to this node.
    let cyclic = false;
    for (let up = parent, steps = 0; up && steps <= nodes.size; up = parentOf(up.c), steps++) {
      if (up === node) {
        cyclic = true;
        break;
      }
    }
    if (parent && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  const sortTree = (list) => {
    list.sort((a, b) => compareComments(a.c, b.c));
    for (const n of list) sortTree(n.children);
  };
  sortTree(roots);
  return roots;
}

/** Facebook draws at most 2 levels of indentation; deeper replies are shown at level 2. */
const MAX_REPLY_LEVEL = 2;

function commentMarkdown(c, level, orphan) {
  const indent = '  '.repeat(level);
  const author = c.authorName ? mdInline(c.authorName) : 'Unknown';
  // A reply whose parent was not saved is listed at the top level; say whom it answers.
  const replyTo = orphan && c.isReply && c.replyToName ? ` (reply to ${mdInline(c.replyToName)})` : '';
  const date = c.createdAtText || c.createdAt || c.relativeTime || '';
  const lines = splitLines(c.text);
  for (const a of c.attachments || []) {
    const url = a && (a.src || a.href);
    if (url) lines.push(`[${a.type || 'attachment'}](${url})`);
  }
  if (c.missingAt) lines[lines.length - 1] = `${lines[lines.length - 1]} (not found in last full scan)`.trimStart();
  const head = `${indent}- **${author}**${replyTo}${date ? ` · ${date}` : ''} — ${lines[0]}`.trimEnd();
  const rest = lines.slice(1).map((line) => (line ? `${indent}  ${line}` : ''));
  return [head, ...rest].join('\n');
}

/** Threaded Markdown bullets for one post's comments (pre-order, indentation capped at 2). */
function threadMarkdown(comments) {
  const out = [];
  const walk = (node, level) => {
    out.push(commentMarkdown(node.c, level, level === 0 && !!node.c.isReply));
    for (const child of node.children) walk(child, Math.min(level + 1, MAX_REPLY_LEVEL));
  };
  for (const root of buildThreads(comments)) walk(root, 0);
  return out.join('\n');
}

/**
 * @param {PostRecord[]} posts
 * @param {CommentRecord[]} comments
 * @param {{exportedAt?: string|Date}} [opts]
 * @returns {string}
 */
export function buildMarkdown(posts, comments, { exportedAt } = {}) {
  const byPost = groupComments(comments);
  const sorted = sortPosts(posts);
  const total = sorted.reduce((n, p) => n + (byPost.get(p.id)?.length || 0), 0);
  const out = ['# Saved comments', '', `_Exported ${toIso(exportedAt)} · ${sorted.length} posts · ${total} comments_`];

  for (const post of sorted) {
    const author = post.authorName ? mdInline(post.authorName) : 'Unknown author';
    const date = post.postedAtText || post.postedAt;
    out.push('', `## ${author}${date ? ` — ${date}` : ''}`, '');
    if (post.url) out.push(post.url, '');
    if (post.text) {
      out.push(splitLines(post.text).map((line) => (line ? `> ${line}` : '>')).join('\n'), '');
    }
    const list = byPost.get(post.id) || [];
    out.push(list.length ? threadMarkdown(list) : '_No comments saved._');
  }
  return `${out.join('\n')}\n`;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * 'fb-comments-<scope>-YYYYMMDD-HHmm.<ext>' (local time).
 * @param {'json'|'csv'|'md'} kind
 * @param {string} scope 'all' or a post id
 * @param {Date|number|string} [date]
 */
export function exportFileName(kind, scope, date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safeScope = String(scope || 'all').replace(/[^\w.-]+/g, '-');
  const ext = { json: 'json', csv: 'csv', md: 'md', markdown: 'md' }[kind] || 'txt';
  return `fb-comments-${safeScope}-${stamp}.${ext}`;
}
