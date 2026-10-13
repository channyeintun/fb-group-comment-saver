// Facebook URL parsing / canonicalization helpers (pure). See SPEC.md §5.

const FB_ORIGIN = 'https://www.facebook.com';

/** Top-level paths that are never a profile vanity name. */
const NON_PROFILE_PATHS = new Set([
  // from the spec
  'groups', 'profile.php', 'photo', 'photos', 'watch', 'events', 'hashtag', 'l.php', 'story.php',
  'permalink.php', 'pages', 'people', 'reel', 'share',
  // other well-known Facebook sections
  'reels', 'stories', 'marketplace', 'gaming', 'search', 'friends', 'messages', 'notifications',
  'bookmarks', 'saved', 'settings', 'help', 'policies', 'privacy', 'login', 'login.php', 'home.php',
  'photo.php', 'video.php', 'sharer.php', 'media', 'live', 'memories', 'fundraisers', 'ads', 'business',
]);

/** /groups/<x> paths that are Facebook sections, not a specific group. */
const NON_GROUP_SLUGS = new Set(['feed', 'discover', 'joins', 'notifications', 'create', 'search', 'you']);

const MOBILE_HOST_RE = /^(m|mbasic|touch|mobile)\.facebook\.com$/;

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function toUrl(href, base) {
  if (href === null || href === undefined || href === '') return null;
  try {
    return new URL(String(href), base || `${FB_ORIGIN}/`);
  } catch {
    return null;
  }
}

/**
 * @typedef {{host: string|null, groupSlug: string|null, postId: string|null, commentId: string|null,
 *   replyCommentId: string|null, userId: string|null, vanity: string|null}} FbUrlParts
 */

/**
 * Extracts Facebook ids from a URL (absolute, or relative to `base` / www.facebook.com).
 * @param {string|null|undefined} href
 * @param {string} [base]
 * @returns {FbUrlParts}
 */
export function parseFbUrl(href, base) {
  /** @type {FbUrlParts} */
  const out = { host: null, groupSlug: null, postId: null, commentId: null, replyCommentId: null, userId: null, vanity: null };
  const url = toUrl(href, base);
  if (!url) return out;

  out.host = url.hostname.toLowerCase();
  const path = url.pathname;
  const q = url.searchParams;

  const group = /^\/groups\/([^/]+)(?:\/|$)/.exec(path);
  if (group) out.groupSlug = safeDecode(group[1]);

  const post = /^\/groups\/[^/]+\/(?:posts|permalink)\/([\w.-]+)/.exec(path);
  if (post) {
    out.postId = post[1];
  } else {
    // ?multi_permalinks may hold a comma-separated list — take the first id.
    const candidate = (q.get('multi_permalinks') || '').split(/[,\s]+/)[0] || q.get('story_fbid') || '';
    if (/^[\w.-]+$/.test(candidate)) out.postId = candidate;
  }

  out.commentId = q.get('comment_id') || null;
  out.replyCommentId = q.get('reply_comment_id') || null;

  const user = /^\/groups\/[^/]+\/user\/(\d+)/.exec(path) || /^\/user\/(\d+)/.exec(path);
  if (user) out.userId = user[1];
  else if (path === '/profile.php' && /^\d+$/.test(q.get('id') || '')) out.userId = q.get('id');

  if (!out.userId && /(^|\.)facebook\.com$/.test(out.host)) {
    const top = /^\/([\w.-]+)\/?$/.exec(path);
    if (top && !NON_PROFILE_PATHS.has(top[1].toLowerCase())) out.vanity = top[1];
  }
  return out;
}

/**
 * Desktop Facebook hosts supported by the extension (m./mbasic. are a different DOM).
 * @param {string|null|undefined} host
 */
export function isFacebookHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return h === 'facebook.com' || h === 'www.facebook.com' || h === 'web.facebook.com';
}

/** @param {string} groupSlug @param {string} postId */
export function canonicalPostUrl(groupSlug, postId) {
  return `${FB_ORIGIN}/groups/${encodeURIComponent(groupSlug)}/posts/${encodeURIComponent(postId)}/`;
}

/**
 * @param {string} groupSlug @param {string} postId @param {string} commentId
 * @param {string|null} [replyCommentId]
 */
export function canonicalCommentUrl(groupSlug, postId, commentId, replyCommentId) {
  let url = `${canonicalPostUrl(groupSlug, postId)}?comment_id=${encodeURIComponent(commentId)}`;
  if (replyCommentId) url += `&reply_comment_id=${encodeURIComponent(replyCommentId)}`;
  return url;
}

/**
 * @param {{userId?: string|null, vanity?: string|null}|null|undefined} parts
 * @returns {string|null}
 */
export function canonicalProfileUrl(parts) {
  const { userId, vanity } = parts || {};
  if (userId) return `${FB_ORIGIN}/profile.php?id=${encodeURIComponent(userId)}`;
  if (vanity) return `${FB_ORIGIN}/${encodeURIComponent(vanity)}`;
  return null;
}

/** Facebook's own tracking params — removed from any URL. */
function isGlobalTrackingParam(name) {
  return name.startsWith('__cft__') || name === '__tn__' || name === 'fbclid';
}

/** Generic-looking params — removed only from facebook.com URLs (external sites may need e.g. `ref`). */
function isFacebookTrackingParam(name) {
  return name === 'ref' || name === 'eid' || name.startsWith('notif_');
}

/**
 * Removes tracking params (__cft__*, __tn__, fbclid everywhere; ref, notif_*, eid on facebook.com).
 * Relative hrefs are resolved against www.facebook.com. Non-http(s) / unparseable input is returned as-is.
 * @param {string|null|undefined} href
 * @returns {string|null}
 */
export function stripTracking(href) {
  if (href === null || href === undefined || href === '') return href ?? null;
  const url = toUrl(href);
  if (!url || !/^https?:$/.test(url.protocol)) return String(href);
  const isFb = /(^|\.)facebook\.com$/i.test(url.hostname);
  for (const name of [...new Set(url.searchParams.keys())]) {
    if (isGlobalTrackingParam(name) || (isFb && isFacebookTrackingParam(name))) url.searchParams.delete(name);
  }
  return url.toString();
}

/**
 * Classifies the active tab's URL for the UI / job runner.
 * @param {string|null|undefined} url
 * @returns {{kind: 'post'|'group'|'facebook'|'mobile'|'other', groupSlug: string|null, postId: string|null}}
 */
export function classifyTabUrl(url) {
  const none = { groupSlug: null, postId: null };
  let u;
  try {
    u = new URL(String(url ?? ''));
  } catch {
    return { kind: 'other', ...none };
  }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'other', ...none };
  const host = u.hostname.toLowerCase();
  if (MOBILE_HOST_RE.test(host)) return { kind: 'mobile', ...none };
  if (!isFacebookHost(host)) return { kind: 'other', ...none };

  const post = /^\/groups\/([^/]+)\/(?:posts|permalink)\/([\w.-]+)/.exec(u.pathname);
  if (post) return { kind: 'post', groupSlug: safeDecode(post[1]), postId: post[2] };

  const group = /^\/groups\/([^/]+)(?:\/|$)/.exec(u.pathname);
  if (group && !NON_GROUP_SLUGS.has(group[1].toLowerCase())) {
    return { kind: 'group', groupSlug: safeDecode(group[1]), postId: null };
  }
  return { kind: 'facebook', ...none };
}

/**
 * Decoded target URL of a Facebook link shim (l.facebook.com/l.php?u=…), or null.
 * @param {string|null|undefined} href
 * @returns {string|null}
 */
export function linkTargetHost(href) {
  const url = toUrl(href);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const shimHost = host === 'l.facebook.com' || host === 'lm.facebook.com' || isFacebookHost(host);
  if (!shimHost || url.pathname !== '/l.php') return null;
  return url.searchParams.get('u') || null;
}
