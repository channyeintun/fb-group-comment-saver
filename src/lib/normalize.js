// Turns a RawExtraction (from src/page/extract.js) into Post/Comment records. See SPEC.md §5.

import { parseFbDate } from './fb-date.js';
import {
  canonicalCommentUrl,
  canonicalPostUrl,
  canonicalProfileUrl,
  parseFbUrl,
  stripTracking,
} from './fb-url.js';

/**
 * @typedef {{type: 'image'|'video'|'link', src?: string, href?: string|null, alt?: string}} Attachment
 * @typedef {{index: number, ariaLabel: string, authorName: string|null, authorHref: string|null,
 *   permalinkHref: string|null, timeAria: string|null, timeText: string|null, text: string, left: number,
 *   reactionLabel: string|null, truncated: boolean, attachments: Attachment[]}} RawComment
 * @typedef {{permalinkHref: string|null, authorName: string|null, authorHref: string|null, text: string,
 *   dateText: string|null, dateAria: string|null, commentCountText: string|null, emptyState: boolean,
 *   items: RawComment[]}} RawPost
 * @typedef {{pageUrl: string, pageTitle: string, rootKind: 'dialog'|'main'|'feed'|'none',
 *   extractedAt: number, posts: RawPost[]}} RawExtraction
 *
 * @typedef {{id: string, groupSlug: string|null, url: string|null, authorName: string|null,
 *   authorId: string|null, authorUrl: string|null, text: string, postedAt: string|null,
 *   postedAtApprox: boolean, postedAtText: string|null, commentCountExpected: number|null,
 *   lastMode: string|null, firstSavedAt: string, lastSavedAt: string, lastFullScanAt: string|null,
 *   savedCommentCount: number}} PostRecord
 * @typedef {{id: string, postId: string, groupSlug: string|null, threadId: string, parentId: string|null,
 *   depth: number, isReply: boolean, replyToName: string|null, replyToKind: 'comment'|'reply'|null,
 *   authorName: string|null, authorId: string|null, authorUrl: string|null, text: string,
 *   truncated: boolean, createdAt: string|null, createdAtApprox: boolean, createdAtText: string|null,
 *   relativeTime: string|null, reactionCount: number, attachments: Attachment[], permalink: string|null,
 *   order: number, firstSavedAt: string, lastSavedAt: string, missingAt: string|null,
 *   previousTexts: {text: string, savedAt: string}[]}} CommentRecord
 */

/** Two indentation `left` values closer than this (px) are treated as the same depth level. */
const LEFT_TOLERANCE_PX = 8;

/** Relative time at the end of a comment aria-label ("… 2 days ago", "… 5h"). */
const ARIA_TIME_TAIL = /\s+(?:just now|a few seconds ago|(?:\d+|an?)\s?[a-z]+(?:\s+ago)?)$/i;

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** djb2 string hash as unsigned hex. */
export function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * Leading count of a label: "5 reactions; …" → 5, "1.2K reactions" → 1200, "1,234" → 1234.
 * @param {string|null|undefined} text
 * @returns {number|null}
 */
export function parseCount(text) {
  const m = /^\s*(\d[\d,]*(?:\.\d+)?)\s*([kmb])?(?![\w])/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * mult);
}

/** Best-effort author name from "Comment by X 2 days ago" / "Reply by X to Y's comment 1d". */
function authorFromAria(label) {
  const m = /^(?:comment|reply) by (.+)$/i.exec(collapse(label));
  if (!m) return null;
  let rest = m[1].replace(ARIA_TIME_TAIL, '');
  const reply = /^(.+?) to .+['’]s (?:comment|reply)$/i.exec(rest);
  if (/^reply by/i.test(label) && reply) rest = reply[1];
  return rest.trim() || null;
}

/**
 * Parses who/what a reply answers from its aria-label.
 * @returns {{name: string|null, kind: 'comment'|'reply'|null}}
 */
function parseReplyTo(ariaLabel, authorName) {
  const label = collapse(ariaLabel);
  if (!/^reply by /i.test(label)) return { name: null, kind: null };
  let rest = null;
  const prefix = authorName ? `reply by ${collapse(authorName)} to ` : null;
  if (prefix && label.toLowerCase().startsWith(prefix.toLowerCase())) {
    rest = label.slice(prefix.length);
  } else {
    const m = /^Reply by (.+?) to (.+)['’]s (comment|reply)\b/i.exec(label);
    if (m) return { name: m[2].trim(), kind: /** @type {'comment'|'reply'} */ (m[3].toLowerCase()) };
  }
  const m = rest !== null ? /^(.+)['’]s (comment|reply)\b/i.exec(rest) : null;
  if (!m) return { name: null, kind: null };
  return { name: m[1].trim(), kind: /** @type {'comment'|'reply'} */ (m[2].toLowerCase()) };
}

/** Groups the positive `left` values of a post's items into indentation levels (sorted). */
function indentLevels(items) {
  const lefts = [...new Set(items.map((it) => it.left).filter((l) => Number.isFinite(l) && l > 0))].sort((a, b) => a - b);
  /** @type {{min: number, max: number}[]} */
  const levels = [];
  for (const l of lefts) {
    const last = levels[levels.length - 1];
    if (last && l - last.max <= LEFT_TOLERANCE_PX) last.max = l;
    else levels.push({ min: l, max: l });
  }
  return levels;
}

/**
 * Post id/slug, from the most trustworthy source:
 * 1. the post id most comment permalinks agree on (they always carry the real numeric /posts/<id>/);
 * 2. for an open post (dialog/main), the page URL;
 * 3. the post's own permalink — a link found inside the post can belong to something else (a link
 *    to another group post in the text, a shared post), so it only decides when 1–2 are missing.
 * A disagreeing post permalink is reported in `warnings`.
 * @returns {(ReturnType<typeof parseFbUrl> & {href: string})|null}
 */
function resolvePostIds(rp, raw, warnings) {
  /** @type {Map<string, {count: number, parts: any}>} */
  const votes = new Map();
  for (const it of rp.items || []) {
    if (!it.permalinkHref) continue;
    const p = parseFbUrl(it.permalinkHref);
    if (!p.postId) continue;
    const v = votes.get(p.postId);
    if (v) v.count++;
    else votes.set(p.postId, { count: 1, parts: { ...p, href: it.permalinkHref } });
  }
  let fromItems = null;
  let best = 0;
  for (const v of votes.values()) {
    if (v.count > best) {
      best = v.count;
      fromItems = v.parts;
    }
  }
  let fromPage = null;
  if (raw.rootKind === 'dialog' || raw.rootKind === 'main') {
    const p = parseFbUrl(raw.pageUrl);
    if (p.postId) fromPage = { ...p, href: raw.pageUrl };
  }
  let fromLink = null;
  if (rp.permalinkHref) {
    const p = parseFbUrl(rp.permalinkHref);
    if (p.postId) fromLink = { ...p, href: rp.permalinkHref };
  }
  const chosen = fromItems || fromPage || fromLink;
  if (chosen && fromLink && fromLink.postId !== chosen.postId) {
    warnings.push(
      `Post ${chosen.postId}: ignored a link to another post (${fromLink.postId}) found inside it; ` +
        'the post id comes from its comments or the page address.',
    );
  }
  return chosen;
}

/** The id source is a non-group URL (permalink.php?story_fbid=…, a profile post): not a group post. */
function isNonGroupSource(ids) {
  try {
    return !/^\/groups\//.test(new URL(ids.href, 'https://www.facebook.com/').pathname);
  } catch {
    return false;
  }
}

/** Post URL from a comment/post link or page URL: tracking and comment params removed. */
function postUrlFromHref(href) {
  const clean = stripTracking(href);
  try {
    const u = new URL(clean);
    u.searchParams.delete('comment_id');
    u.searchParams.delete('reply_comment_id');
    return u.toString();
  } catch {
    return clean;
  }
}

function authorFields(href) {
  if (!href) return { authorId: null, authorUrl: null };
  const p = parseFbUrl(href);
  return { authorId: p.userId, authorUrl: canonicalProfileUrl(p) || stripTracking(href) };
}

/** First date string that parses, else the result for the first non-empty one. */
function parseFirstDate(candidates, refMs) {
  let result = { iso: null, approx: true };
  for (const text of candidates) {
    if (!text) continue;
    result = parseFbDate(text, refMs);
    if (result.iso) break;
  }
  return result;
}

/**
 * Normalizes one RawPost's comment items. Returns records in DOM order.
 * @param {RawComment[]} items
 * @param {{postId: string, groupSlug: string|null, refMs: number, savedAt: string}} ctx
 * @returns {{records: CommentRecord[], synthetic: number}}
 */
function normalizeComments(items, { postId, groupSlug, refMs, savedAt }) {
  const levels = indentLevels(items);
  const usedIds = new Set();
  let synthetic = 0;

  /** @type {CommentRecord[]} */
  const records = items.map((it, i) => {
    const ariaLabel = it.ariaLabel || '';
    const authorName = it.authorName || authorFromAria(ariaLabel);
    const text = it.text || '';
    const link = it.permalinkHref ? parseFbUrl(it.permalinkHref) : null;
    const commentId = link?.commentId || null;
    const replyCommentId = link?.replyCommentId || null;

    let id = replyCommentId ?? commentId;
    if (!id) {
      synthetic++;
      id = `h:${postId}:${djb2(`${authorName ?? ''}|${text}|${it.timeAria || it.timeText || ''}`)}`;
    }
    // Keep ids unique within the post (e.g. two identical "+1" comments without permalinks).
    if (usedIds.has(id)) {
      let k = 2;
      while (usedIds.has(`${id}~${k}`)) k++;
      id = `${id}~${k}`;
    }
    usedIds.add(id);

    const isReply = !!replyCommentId || /^reply by /i.test(collapse(ariaLabel));
    const replyTo = isReply ? parseReplyTo(ariaLabel, authorName) : { name: null, kind: null };

    let depth = null;
    if (levels.length >= 2 && Number.isFinite(it.left) && it.left > 0) {
      depth = levels.findIndex((lv) => it.left >= lv.min && it.left <= lv.max);
    }
    if (depth === null || depth < 0) depth = isReply ? (replyTo.kind === 'reply' ? 2 : 1) : 0;
    depth = isReply ? Math.max(1, depth) : 0;

    const date = parseFirstDate([it.timeAria, it.timeText, ariaLabel], refMs);
    const { authorId, authorUrl } = authorFields(it.authorHref);

    let permalink = null;
    if (commentId && groupSlug) permalink = canonicalCommentUrl(groupSlug, postId, commentId, replyCommentId);
    else if (it.permalinkHref) permalink = stripTracking(it.permalinkHref);

    const attachments = (Array.isArray(it.attachments) ? it.attachments : []).map((a) =>
      a && a.href ? { ...a, href: stripTracking(a.href) } : { ...a },
    );

    return {
      id,
      postId,
      groupSlug,
      threadId: commentId || id, // provisional for replies without a permalink (see below)
      parentId: null,
      depth,
      isReply,
      replyToName: replyTo.name,
      replyToKind: replyTo.kind,
      authorName: authorName || null,
      authorId,
      authorUrl,
      text,
      truncated: !!it.truncated,
      createdAt: date.iso,
      createdAtApprox: date.approx,
      createdAtText: it.timeAria || it.timeText || null,
      relativeTime: it.timeText || null,
      reactionCount: parseCount(it.reactionLabel) ?? 0,
      attachments,
      permalink,
      order: Number.isFinite(it.index) ? it.index : i,
      firstSavedAt: savedAt,
      lastSavedAt: savedAt,
      missingAt: null,
      previousTexts: [],
      _hasThread: !!commentId,
    };
  });

  // Replies without a permalink: DOM order is pre-order, so the thread root is the nearest
  // previous top-level comment.
  records.forEach((rec, i) => {
    if (!rec.isReply || rec._hasThread) return;
    for (let j = i - 1; j >= 0; j--) {
      if (records[j].depth === 0) {
        rec.threadId = records[j].threadId;
        break;
      }
    }
  });

  // Parent = nearest previous item of the same thread one level up; else the thread root.
  // Facebook caps indentation at 2, so a reply to a depth-2 reply is drawn at depth 2 as well;
  // when the aria-label names the replied-to reply ("to X's reply"), the nearest previous reply by
  // X in the same thread is the real parent (live-verified on the group). Items are drawn in
  // pre-order, so that reply can only be in the reply's own branch: the search stops at the branch
  // head (the nearest previous item one level up), which is checked too; if X's reply is not
  // there (deleted, not loaded), the branch head is the parent.
  records.forEach((rec, i) => {
    if (!rec.isReply) return;
    if (rec.replyToKind === 'reply' && rec.replyToName) {
      const want = collapse(rec.replyToName);
      for (let j = i - 1; j >= 0; j--) {
        const prev = records[j];
        if (prev.threadId !== rec.threadId) continue;
        if (prev.isReply && collapse(prev.authorName) === want) {
          rec.parentId = prev.id;
          return;
        }
        if (prev.depth < rec.depth) break; // branch head reached
      }
    }
    for (let j = i - 1; j >= 0; j--) {
      const prev = records[j];
      if (prev.threadId === rec.threadId && prev.depth === rec.depth - 1) {
        rec.parentId = prev.id;
        break;
      }
    }
    if (!rec.parentId && rec.threadId !== rec.id) rec.parentId = rec.threadId;
  });

  for (const rec of records) delete rec._hasThread;
  return { records, synthetic };
}

/**
 * @param {RawExtraction} raw
 * @param {{savedAt?: string, fallbackGroupSlug?: string|null, mode?: 'quick'|'post'|'crawl'}} [opts]
 * @returns {{posts: PostRecord[], comments: CommentRecord[], warnings: string[]}}
 */
export function normalizeExtraction(raw, opts = {}) {
  const savedAt = opts.savedAt || new Date().toISOString();
  const mode = opts.mode || null;
  const refMs = Number.isFinite(raw?.extractedAt) ? raw.extractedAt : Date.parse(savedAt);
  const pageSlug = raw?.pageUrl ? parseFbUrl(raw.pageUrl).groupSlug : null;

  /** @type {PostRecord[]} */ const posts = [];
  /** @type {CommentRecord[]} */ const comments = [];
  /** @type {string[]} */ const warnings = [];
  const seenPosts = new Set();
  const seenComments = new Set();

  const rawPosts = Array.isArray(raw?.posts) ? raw.posts : [];
  if (!rawPosts.length) warnings.push(`No post found on the page (root: ${raw?.rootKind || 'none'}).`);

  rawPosts.forEach((rp, index) => {
    const items = Array.isArray(rp.items) ? rp.items : [];
    const ids = resolvePostIds(rp, raw, warnings);
    if (!ids) {
      const who = rp.authorName ? ` by ${rp.authorName}` : '';
      warnings.push(`Skipped post #${index + 1}${who}: no post id found (${items.length} comments not saved).`);
      return;
    }
    const postId = /** @type {string} */ (ids.postId);
    // A post identified by a non-group URL (e.g. story_fbid on the home feed) is not filed under a
    // group unless the page itself is a group page.
    const nonGroup = !ids.groupSlug && isNonGroupSource(ids);
    const groupSlug = ids.groupSlug || (nonGroup ? pageSlug : opts.fallbackGroupSlug || pageSlug) || null;

    const { records, synthetic } = normalizeComments(items, { postId, groupSlug, refMs, savedAt });
    if (synthetic) {
      warnings.push(`Post ${postId}: ${synthetic} comment(s) had no permalink; synthetic ids were used.`);
    }
    for (const rec of records) {
      if (seenComments.has(rec.id)) continue;
      seenComments.add(rec.id);
      comments.push(rec);
    }

    if (seenPosts.has(postId)) {
      warnings.push(`Post ${postId} appeared more than once; kept the first occurrence.`);
      return;
    }
    seenPosts.add(postId);

    const posted = parseFirstDate([rp.dateAria, rp.dateText], refMs);
    const { authorId, authorUrl } = authorFields(rp.authorHref);
    // Without a group: the id source's own URL (tracking and comment params removed).
    const url = groupSlug ? canonicalPostUrl(groupSlug, postId) : postUrlFromHref(ids.href);

    posts.push({
      id: postId,
      groupSlug,
      url,
      authorName: rp.authorName || null,
      authorId,
      authorUrl,
      text: rp.text || '',
      postedAt: posted.iso,
      postedAtApprox: posted.approx,
      postedAtText: rp.dateAria || rp.dateText || null,
      commentCountExpected: rp.commentCountText ? parseCount(String(rp.commentCountText).replace(/^\D+/, '')) : null,
      lastMode: mode,
      firstSavedAt: savedAt,
      lastSavedAt: savedAt,
      lastFullScanAt: null,
      savedCommentCount: records.length,
    });
  });

  return { posts, comments, warnings };
}
