// Library page: browse, search, export and manage the saved archive. See SPEC.md §8.
// Deep link: library.html#post=<postId> (optionally &comment=<commentId>) selects that post on load.

import { MSG } from '../lib/constants.js';
import { getSettings, buildGroupFeedUrl } from '../lib/settings.js';
import { listPosts, getPost, getComments, searchComments, getStats, deletePost, clearAll } from '../lib/db.js';
import { buildThreads } from '../lib/export.js';
import {
  el,
  safeUrl,
  formatDate,
  relTime,
  formatNumber,
  plural,
  debounce,
  exportArchive,
  showToast,
} from './common.js';

/** @typedef {Record<string, any>} PostRecord  (SPEC §5 PostRecord) */
/** @typedef {Record<string, any>} CommentRecord  (SPEC §5 CommentRecord) */
/** @typedef {{ c: CommentRecord, children: ThreadNode[] }} ThreadNode */

const SEARCH_LIMIT = 500;
const WIDE = matchMedia('(min-width: 760px)');
const EXPORT_KINDS = /** @type {const} */ (['json', 'csv', 'md']);
const EXPORT_NAME = { json: 'JSON', csv: 'CSV', md: 'Markdown' };
const CSV_TIP = ' (in Excel or Sheets, import the id columns as Text: Facebook ids have more digits than Excel keeps)';
const PARTIAL_TIP =
  'Not fully scanned yet — open the post on Facebook and click “Save all comments” in the side panel to expand every comment.';
const EMPTY_SENTENCE = 'No saved comments yet — open a post in the group and click Save all comments.';

/** 16×16 stroke icons (path data). */
const ICONS = {
  external: ['M9.5 2.5h4v4', 'M13.5 2.5 7.5 8.5', 'M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3'],
  trash: ['M2.5 4.5h11', 'M6.5 4.5V3h3v1.5', 'M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6'],
  back: ['M9.5 3.5 5 8l4.5 4.5'],
  comment: ['M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7.2l-3 2.4V11H4a1.5 1.5 0 0 1-1.5-1.5z'],
  heart: ['M8 13.2S2.5 10 2.5 6.3A2.8 2.8 0 0 1 8 5.1a2.8 2.8 0 0 1 5.5 1.2C13.5 10 8 13.2 8 13.2z'],
  search: ['M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z', 'm10.5 10.5 3 3'],
  inbox: ['M2.5 9.5 4 3.5h8l1.5 6', 'M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3h-3.3a2.2 2.2 0 0 1-4.4 0z'],
  select: ['M3 3.5h10', 'M3 8h6', 'M3 12.5h8'],
  video: ['M3 4h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'm11 7 3-2v6l-3-2'],
  link: ['M6.5 9.5l3-3', 'M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1', 'M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1'],
};

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const errMsg = (/** @type {any} */ err) => (err && err.message) || String(err);
const num = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

const state = {
  /** @type {PostRecord[]} */
  posts: [],
  /** @type {Map<string, PostRecord>} */
  postsById: new Map(),
  loaded: false,
  /** @type {string|null} */
  loadError: null,
  /** @type {{posts: number, comments: number, lastSavedAt: string|null}|null} */
  stats: null,
  /** @type {string|null} */
  selectedId: null,
  filter: '',
  sort: 'saved',
  /** Active search (non-empty → the detail pane shows search results). */
  query: '',
  /** @type {CommentRecord[]} */
  results: [],
  /** Search to go back to after opening a result. @type {string|null} */
  returnQuery: null,
  /** @type {string|null} */
  groupUrl: null,
};
let detailToken = 0;
let searchToken = 0;

// =============================================================================================
// Small render helpers

/** @param {string[]} paths @param {string} [cls] */
function icon(paths, cls = 'icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', cls);
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** First user-perceived character (keeps Myanmar consonant + medials and emoji together). */
function firstGrapheme(/** @type {string} */ s) {
  if (!s) return '';
  if (segmenter) for (const { segment } of segmenter.segment(s)) return segment;
  return Array.from(s)[0] || '';
}

/** Stable hue for a name (djb2). */
function hue(/** @type {string} */ s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/** @param {string|null|undefined} name @param {string} [size] */
function avatar(name, size) {
  const label = (name || '').trim();
  return el(
    'span',
    { class: ['avatar', size === 'lg' && 'avatar-lg'], style: { '--hue': hue(label || '?') }, 'aria-hidden': 'true' },
    (firstGrapheme(label) || '?').toUpperCase(),
  );
}

/** Author name, linked to the profile when a safe URL is known. */
function authorLink(/** @type {string|null|undefined} */ name, /** @type {string|null|undefined} */ url, /** @type {string} */ cls) {
  const text = name || 'Unknown author';
  return safeUrl(url)
    ? el('a', { class: cls, href: url, target: '_blank', rel: 'noopener noreferrer', dir: 'auto', title: 'Open profile on Facebook' }, text)
    : el('span', { class: cls, dir: 'auto' }, text);
}

/** Single-line preview of a text. */
function preview(/** @type {string|null|undefined} */ text, max = 220) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const shortDateYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Oct 4" (this year) or "Oct 4, 2025"; falls back to Facebook's own text. */
function shortDate(/** @type {string|null|undefined} */ iso, /** @type {string|null|undefined} */ fallback) {
  const t = iso ? new Date(iso) : null;
  if (!t || Number.isNaN(t.getTime())) return fallback || '—';
  return (t.getFullYear() === new Date().getFullYear() ? shortDateFmt : shortDateYearFmt).format(t);
}

/** @param {string|null|undefined} iso */
function timeValue(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
}

/** Descending by time, nulls last. */
function byTimeDesc(/** @type {string|null|undefined} */ a, /** @type {string|null|undefined} */ b) {
  const ta = timeValue(a);
  const tb = timeValue(b);
  if (ta == null && tb == null) return 0;
  if (ta == null) return 1;
  if (tb == null) return -1;
  return tb - ta;
}

function escapeRegExp(/** @type {string} */ s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits `text` into text + <mark> nodes for each case-insensitive occurrence of `query`. */
function highlight(/** @type {string} */ text, /** @type {string} */ query) {
  if (!text || !query) return [text || ''];
  const re = new RegExp(escapeRegExp(query), 'gi');
  /** @type {(string|HTMLElement)[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = /** @type {number} */ (m.index);
    if (i > last) out.push(text.slice(last, i));
    out.push(el('mark', null, m[0]));
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Up to `max` chars of `text`, centred on the first match of `query`. */
function snippet(/** @type {string} */ text, /** @type {string} */ query, max = 320) {
  const s = String(text || '');
  if (s.length <= max) return s;
  const idx = query ? s.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = idx > 100 ? idx - 100 : 0;
  const end = Math.min(s.length, start + max);
  return `${start > 0 ? '…' : ''}${s.slice(start, end)}${end < s.length ? '…' : ''}`;
}

/** "facebook.com/some/path…" for link attachments. */
function linkLabel(/** @type {string} */ href) {
  try {
    const u = new URL(href);
    const label = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
    return label.length > 48 ? `${label.slice(0, 47)}…` : label;
  } catch {
    return href.slice(0, 48);
  }
}

/**
 * @param {string[]} iconPaths @param {string} title @param {string} text
 * @param {Node|null} [action]
 */
function emptyView(iconPaths, title, text, action = null) {
  return el(
    'div',
    { class: 'empty' },
    icon(iconPaths, 'empty-icon'),
    el('p', { class: 'empty-title' }, title),
    el('p', { class: 'empty-text' }, text),
    action,
  );
}

function loadingView(/** @type {string} */ text) {
  return el('div', { class: 'loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

/** @param {HTMLElement} detail @param {string} view @param {...Node} nodes */
function setDetail(detail, view, ...nodes) {
  detail.dataset.view = view;
  detail.setAttribute('aria-busy', view === 'loading' ? 'true' : 'false');
  detail.replaceChildren(...nodes);
}

function announce(/** @type {string} */ text) {
  const node = $('sr-status');
  node.textContent = '';
  // A separate tick makes screen readers re-announce identical text.
  setTimeout(() => (node.textContent = text), 50);
}

/** Tell the side panel (and any other extension page) that saved data changed. */
function notifyChanged(/** @type {string[]} */ postIds) {
  Promise.resolve()
    .then(() => chrome.runtime.sendMessage({ type: MSG.DB_CHANGED, postIds }))
    .catch(() => {});
}

// =============================================================================================
// Data loading & top bar

async function loadPosts() {
  try {
    const [posts, stats] = await Promise.all([listPosts(), getStats()]);
    state.posts = Array.isArray(posts) ? posts : [];
    state.postsById = new Map(state.posts.map((p) => [p.id, p]));
    state.stats = stats;
    state.loadError = null;
  } catch (err) {
    state.loadError = errMsg(err);
  }
  state.loaded = true;
  renderStats();
  renderPostList();
}

function renderStats() {
  const node = $('stats');
  const s = state.stats;
  if (state.loadError) node.textContent = 'Archive unavailable';
  else if (!s) node.textContent = 'Loading…';
  else if (!s.posts) node.textContent = 'Nothing saved yet';
  else {
    node.textContent = `${plural(num(s.posts), 'post')} · ${plural(num(s.comments), 'comment')} · last saved ${relTime(s.lastSavedAt)}`;
    node.title = s.lastSavedAt ? `Last saved ${formatDate(s.lastSavedAt)}` : '';
  }

  const empty = !s || !s.posts;
  for (const btn of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-export-all]'))) {
    if (btn.getAttribute('aria-busy') === 'true') continue;
    btn.disabled = empty;
    btn.title = empty
      ? 'Nothing to export yet'
      : `Download all ${plural(num(s?.posts), 'post')} as ${EXPORT_NAME[/** @type {keyof EXPORT_NAME} */ (btn.dataset.exportAll)]}${
          btn.dataset.exportAll === 'csv' ? CSV_TIP : ''
        }`;
  }
  const clear = /** @type {HTMLButtonElement} */ ($('btn-clear'));
  clear.disabled = empty;
  clear.title = empty ? 'The archive is already empty' : 'Permanently delete every saved post and comment';
}

/**
 * Runs an export with a busy state on the clicked button.
 * @param {'json'|'csv'|'md'} kind @param {string|undefined} postId @param {HTMLButtonElement} btn
 */
async function runExport(kind, postId, btn) {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const r = await exportArchive(kind, postId);
    showToast(`Downloaded ${r.filename}`, { tone: 'ok' });
  } catch (err) {
    showToast(errMsg(err), { tone: 'danger' });
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    renderStats();
  }
}

async function confirmClearAll() {
  const s = state.stats;
  const what = s ? ` (${plural(num(s.posts), 'post')}, ${plural(num(s.comments), 'comment')})` : '';
  if (!confirm(`Delete ALL saved posts and comments${what}?\n\nThis can’t be undone. Consider exporting a JSON backup first.`)) return;
  if (!confirm('Are you absolutely sure? Everything in the archive will be permanently deleted.')) return;
  try {
    await clearAll();
    notifyChanged([]);
    state.selectedId = null;
    state.returnQuery = null;
    clearSearchState();
    writeHash(null);
    await loadPosts();
    renderIdle();
    showToast('Archive cleared.', { tone: 'ok' });
  } catch (err) {
    showToast(`Couldn’t clear the archive: ${errMsg(err)}`, { tone: 'danger' });
  }
}

// =============================================================================================
// Post list (left column)

function visiblePosts() {
  const f = state.filter.trim().toLowerCase();
  const list = f
    ? state.posts.filter((p) => `${p.authorName ?? ''}\n${p.text ?? ''}`.toLowerCase().includes(f))
    : [...state.posts];
  if (state.sort === 'posted') list.sort((a, b) => byTimeDesc(a.postedAt, b.postedAt));
  else if (state.sort === 'comments') list.sort((a, b) => num(b.savedCommentCount) - num(a.savedCommentCount));
  else list.sort((a, b) => byTimeDesc(a.lastSavedAt, b.lastSavedAt));
  return list;
}

function renderPostList() {
  const list = $('post-list');
  const count = $('post-count');
  if (!state.loaded) {
    count.textContent = '';
    list.replaceChildren(
      ...Array.from({ length: 5 }, () =>
        el(
          'li',
          { class: 'post-skeleton', 'aria-hidden': 'true' },
          el('span', { class: 'skeleton sk-line sk-short' }),
          el('span', { class: 'skeleton sk-line' }),
          el('span', { class: 'skeleton sk-line sk-mid' }),
        ),
      ),
    );
    return;
  }
  if (state.loadError) {
    count.textContent = '';
    list.replaceChildren(el('li', { class: 'list-msg is-error' }, `Couldn’t load the archive: ${state.loadError}`));
    return;
  }
  const posts = visiblePosts();
  count.textContent = state.filter.trim()
    ? `${formatNumber(posts.length)} of ${formatNumber(state.posts.length)}`
    : formatNumber(state.posts.length);
  if (!state.posts.length) {
    list.replaceChildren(el('li', { class: 'list-msg' }, EMPTY_SENTENCE));
    return;
  }
  if (!posts.length) {
    list.replaceChildren(el('li', { class: 'list-msg' }, `No posts match “${state.filter.trim()}”.`));
    return;
  }
  // Re-rendering replaces the buttons; keep keyboard focus on the same post.
  const active = /** @type {HTMLElement|null} */ (document.activeElement);
  const focusedId = active && list.contains(active) ? active.dataset.id : null;
  list.replaceChildren(...posts.map(renderPostItem));
  if (focusedId) /** @type {HTMLElement|null} */ (list.querySelector(`[data-id="${CSS.escape(focusedId)}"]`))?.focus();
}

/** @param {PostRecord} p */
function renderPostItem(p) {
  const saved = num(p.savedCommentCount);
  const expected = p.commentCountExpected;
  const countText =
    typeof expected === 'number' && saved <= expected ? `${formatNumber(saved)} / ${formatNumber(expected)}` : formatNumber(saved);
  const countTitle =
    typeof expected === 'number'
      ? `${plural(saved, 'comment')} saved of ${formatNumber(expected)} counted by Facebook`
      : `${plural(saved, 'comment')} saved`;
  return el(
    'li',
    null,
    el(
      'button',
      {
        type: 'button',
        class: 'post-item',
        'aria-current': p.id === state.selectedId ? 'true' : null,
        dataset: { id: p.id },
        onclick: () => selectPost(p.id),
      },
      el(
        'span',
        { class: 'pi-top' },
        el('span', { class: 'pi-author', dir: 'auto' }, p.authorName || 'Unknown author'),
        el('span', { class: 'pi-date', title: p.postedAtText || formatDate(p.postedAt) }, shortDate(p.postedAt, p.postedAtText)),
      ),
      el('span', { class: ['pi-preview', !p.text && 'is-empty'], dir: 'auto' }, preview(p.text) || 'No text'),
      el(
        'span',
        { class: 'pi-meta' },
        el('span', { class: 'pi-count', title: countTitle }, icon(ICONS.comment), countText),
        el('span', { class: 'pi-saved', title: `Last saved ${formatDate(p.lastSavedAt)}` }, `saved ${relTime(p.lastSavedAt)}`),
        p.lastFullScanAt ? null : el('span', { class: 'badge tone-warn', title: PARTIAL_TIP }, 'Partial'),
      ),
    ),
  );
}

function updateListSelection() {
  let current = null;
  for (const btn of /** @type {NodeListOf<HTMLElement>} */ ($('post-list').querySelectorAll('.post-item'))) {
    const on = btn.dataset.id === state.selectedId;
    if (on) {
      btn.setAttribute('aria-current', 'true');
      current = btn;
    } else btn.removeAttribute('aria-current');
  }
  current?.scrollIntoView({ block: 'nearest' });
}

/** Arrow keys move between posts in the list. */
function onListKeydown(/** @type {KeyboardEvent} */ e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const items = /** @type {HTMLElement[]} */ ([...$('post-list').querySelectorAll('.post-item')]);
  if (!items.length) return;
  const i = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  let next = i;
  if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
  else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
  else if (e.key === 'Home') next = 0;
  else next = items.length - 1;
  e.preventDefault();
  items[next]?.focus();
}

// =============================================================================================
// Selection & post detail (right column)

/**
 * @param {string} id
 * @param {{ commentId?: string|null, keepReturn?: boolean }} [opts]
 */
async function selectPost(id, { commentId = null, keepReturn = false } = {}) {
  if (!keepReturn) state.returnQuery = null;
  if (state.query) clearSearchState();
  state.selectedId = id;
  writeHash(id);
  updateListSelection();
  await showPostDetail(id, { commentId });
  if (!WIDE.matches && !commentId) $('detail').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function scrollTopOf(/** @type {HTMLElement} */ detail) {
  return WIDE.matches ? detail.scrollTop : window.scrollY;
}

function setScrollTop(/** @type {HTMLElement} */ detail, /** @type {number} */ top) {
  if (WIDE.matches) detail.scrollTop = top;
  else if (top) window.scrollTo({ top });
}

/**
 * Loads and renders a post. With `preserveScroll` (live refresh) the current view stays until the
 * new one is ready and the scroll position is kept.
 * @param {string} id
 * @param {{ commentId?: string|null, preserveScroll?: boolean }} [opts]
 */
async function showPostDetail(id, { commentId = null, preserveScroll = false } = {}) {
  const token = ++detailToken;
  const detail = $('detail');
  const top = preserveScroll ? scrollTopOf(detail) : 0;
  if (!preserveScroll) setDetail(detail, 'loading', loadingView('Loading comments…'));

  /** @type {PostRecord|undefined} */
  let post;
  /** @type {CommentRecord[]} */
  let comments = [];
  try {
    post = await getPost(id);
    if (post) comments = await getComments(id);
  } catch (err) {
    if (token === detailToken) {
      setDetail(detail, 'error', emptyView(ICONS.inbox, 'Couldn’t load this post', errMsg(err)));
    }
    return;
  }
  if (token !== detailToken) return; // another selection happened meanwhile

  if (!post) {
    setDetail(
      detail,
      'missing',
      emptyView(ICONS.inbox, 'Post not in your archive', `There is no saved post with id ${id}. It may have been deleted.`),
    );
    return;
  }
  setDetail(detail, 'post', renderPostDetail(post, comments));
  setScrollTop(detail, top);
  if (commentId) focusComment(commentId);
}

/** Scrolls to and highlights a comment (`#c-<id>`). */
function focusComment(/** @type {string} */ commentId) {
  const node = document.getElementById(`c-${commentId}`);
  if (!node) {
    showToast('That comment is no longer part of this post.', { tone: 'warn' });
    return;
  }
  for (const old of document.querySelectorAll('.comment.is-target')) old.classList.remove('is-target');
  node.classList.add('is-target');
  node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.focus({ preventScroll: true });
}

/** @param {PostRecord} post @param {CommentRecord[]} comments */
function renderPostDetail(post, comments) {
  const roots = buildThreads(comments);
  const replies = comments.filter((c) => c.isReply).length;
  const missing = comments.filter((c) => c.missingAt).length;
  const saved = comments.length;
  const expected = post.commentCountExpected;
  const postUrl = safeUrl(post.url);

  const back = state.returnQuery
    ? el(
        'button',
        { class: 'btn btn-ghost btn-sm back-btn', type: 'button', onclick: backToResults },
        icon(ICONS.back),
        `Back to results for “${state.returnQuery}”`,
      )
    : null;

  const header = el(
    'header',
    { class: 'pd-header' },
    el(
      'div',
      { class: 'pd-byline' },
      avatar(post.authorName, 'lg'),
      el(
        'div',
        { class: 'pd-byline-text' },
        authorLink(post.authorName, post.authorUrl, 'pd-author'),
        el(
          'p',
          { class: 'pd-sub' },
          el(
            'time',
            { datetime: post.postedAt || null, title: post.postedAtText ? `Facebook showed: ${post.postedAtText}` : null },
            post.postedAt ? `${post.postedAtApprox ? '≈ ' : ''}${formatDate(post.postedAt)}` : post.postedAtText || 'Date unknown',
          ),
          post.groupSlug ? el('span', { class: 'pd-group' }, ` · ${post.groupSlug}`) : null,
        ),
      ),
    ),
    el(
      'div',
      { class: 'pd-actions' },
      postUrl
        ? el(
            'a',
            { class: 'btn btn-sm', href: postUrl, target: '_blank', rel: 'noopener noreferrer' },
            'Open on Facebook',
            icon(ICONS.external),
          )
        : null,
      el(
        'div',
        { class: 'btn-group', role: 'group', 'aria-label': 'Export this post' },
        EXPORT_KINDS.map((kind) =>
          el(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              'aria-label': `Export this post as ${EXPORT_NAME[kind]}`,
              title: `Download this post and its comments as ${EXPORT_NAME[kind]}${kind === 'csv' ? CSV_TIP : ''}`,
              onclick: (/** @type {MouseEvent} */ e) => runExport(kind, post.id, /** @type {HTMLButtonElement} */ (e.currentTarget)),
            },
            kind === 'md' ? 'MD' : EXPORT_NAME[kind],
          ),
        ),
      ),
      el(
        'button',
        { class: 'btn btn-sm btn-danger-ghost', type: 'button', onclick: () => confirmDeletePost(post, saved) },
        icon(ICONS.trash),
        'Delete post',
      ),
    ),
  );

  const facts = el(
    'div',
    { class: 'pd-facts' },
    el(
      'span',
      {
        class: 'badge',
        title:
          typeof expected === 'number'
            ? 'Facebook’s count can include deleted or hidden comments, so it may be higher than what can be saved.'
            : null,
      },
      typeof expected !== 'number'
        ? `${plural(saved, 'comment')} saved`
        : saved <= expected
          ? `${formatNumber(saved)} of ${plural(expected, 'comment')} saved`
          : `${plural(saved, 'comment')} saved · Facebook shows ${formatNumber(expected)}`,
    ),
    post.lastFullScanAt
      ? el('span', { class: 'badge tone-ok', title: formatDate(post.lastFullScanAt) }, `Full scan ${relTime(post.lastFullScanAt)}`)
      : el('span', { class: 'badge tone-warn', title: PARTIAL_TIP }, 'Partial — not fully scanned'),
    missing
      ? el('span', { class: 'badge tone-danger', title: 'Saved earlier but not found in the last full scan' }, `${formatNumber(missing)} not found in last scan`)
      : null,
    el('span', { class: 'pd-fact', title: formatDate(post.lastSavedAt) }, `Last saved ${relTime(post.lastSavedAt)}`),
    el('span', { class: 'pd-fact', title: formatDate(post.firstSavedAt) }, `First saved ${shortDate(post.firstSavedAt)}`),
  );

  const text = post.text
    ? el('div', { class: 'pd-text prose', dir: 'auto' }, post.text)
    : el('p', { class: 'pd-text is-empty' }, 'No post text was saved — it may be only a photo, video or link.');

  const commentsSection = el(
    'section',
    { class: 'comments', 'aria-labelledby': 'comments-heading' },
    el(
      'div',
      { class: 'comments-head' },
      el('h2', { id: 'comments-heading' }, 'Comments'),
      saved ? el('span', { class: 'small muted' }, `${plural(saved - replies, 'comment')} · ${plural(replies, 'reply', 'replies')}`) : null,
    ),
    saved
      ? renderThreadList(roots, 0)
      : emptyView(
          ICONS.comment,
          'No comments saved for this post',
          post.lastFullScanAt
            ? 'The last full scan found no comments.'
            : 'Open the post on Facebook and click “Save all comments” in the side panel.',
        ),
  );

  return el('article', { class: 'post-detail', 'aria-label': `Post by ${post.authorName || 'unknown author'}` }, back, header, facts, text, commentsSection);
}

/**
 * Facebook draws at most 2 levels of reply indentation. Replies to replies can chain much deeper
 * (parentId follows "to X's reply"), so below level 2 the rest of a branch is listed flat; each
 * reply's "replying to X" label still says whom it answers.
 */
const MAX_NEST_LEVEL = 2;

/** A node followed by all of its descendants, in pre-order. @param {ThreadNode} node @returns {ThreadNode[]} */
function preOrder(node) {
  return [node, ...node.children.flatMap(preOrder)];
}

/**
 * Reply trees come from buildThreads (src/lib/export.js): parentId, else the thread root; two
 * passes, so a reply is attached even when its stored order sorts before its parent's.
 * @param {ThreadNode[]} nodes @param {number} level
 */
function renderThreadList(nodes, level) {
  const items = level >= MAX_NEST_LEVEL ? nodes.flatMap(preOrder) : nodes;
  return el(
    'ol',
    { class: level === 0 ? 'thread' : 'thread thread-replies', role: 'list' },
    items.map((n) =>
      el(
        'li',
        { class: 'thread-item' },
        renderComment(n.c, level),
        level < MAX_NEST_LEVEL && n.children.length ? renderThreadList(n.children, level + 1) : null,
      ),
    ),
  );
}

/** @param {CommentRecord} c */
function commentDateTitle(c) {
  const parts = [];
  if (c.createdAtText) parts.push(`Facebook showed: ${c.createdAtText}`);
  if (c.createdAtApprox) parts.push('Approximate time');
  if (c.firstSavedAt) parts.push(`First saved ${formatDate(c.firstSavedAt)}`);
  return parts.join('\n') || null;
}

/** @param {CommentRecord} c @param {number} level nesting level in the rendered tree */
function renderComment(c, level) {
  // Replies whose parent wasn't found are shown at the root, indented by their own depth.
  const orphanIndent = level === 0 && num(c.depth) > 0 ? Math.min(num(c.depth), 4) : 0;
  const edits = Array.isArray(c.previousTexts) ? c.previousTexts : [];
  const attachments = Array.isArray(c.attachments) ? c.attachments : [];
  const reactions = num(c.reactionCount);
  const permalink = safeUrl(c.permalink);

  const body = c.text
    ? el('div', { class: 'c-text prose', dir: 'auto' }, c.text)
    : attachments.length
      ? null
      : el('div', { class: 'c-text is-empty' }, 'No text (sticker, GIF or removed content)');

  return el(
    'article',
    {
      id: `c-${c.id}`,
      class: ['comment', c.missingAt && 'is-missing', orphanIndent && 'is-orphan'],
      style: orphanIndent ? { '--indent': orphanIndent } : null,
      tabindex: '-1',
      'aria-label': `${c.isReply ? 'Reply' : 'Comment'} by ${c.authorName || 'unknown author'}`,
    },
    avatar(c.authorName),
    el(
      'div',
      { class: 'c-main' },
      el(
        'div',
        { class: 'c-bubble' },
        el(
          'div',
          { class: 'c-head' },
          authorLink(c.authorName, c.authorUrl, 'c-author'),
          c.isReply && c.replyToName ? el('span', { class: 'c-replyto', dir: 'auto' }, `replying to ${c.replyToName}`) : null,
        ),
        body,
      ),
      renderAttachments(attachments),
      el(
        'div',
        { class: 'c-meta' },
        el(
          'time',
          { datetime: c.createdAt || null, title: commentDateTitle(c) },
          c.createdAt ? `${c.createdAtApprox ? '≈ ' : ''}${formatDate(c.createdAt)}` : c.createdAtText || 'Date unknown',
        ),
        reactions ? el('span', { class: 'c-reactions', title: plural(reactions, 'reaction') }, icon(ICONS.heart), formatNumber(reactions)) : null,
        c.truncated
          ? el('span', { class: 'badge tone-warn', title: 'Facebook showed “See more” and the full text could not be loaded' }, 'Truncated')
          : null,
        c.missingAt
          ? el(
              'span',
              {
                class: 'badge tone-danger',
                title: `Not found in the full scan on ${formatDate(c.missingAt)} — it may have been deleted or hidden.`,
              },
              'Not found in last full scan',
            )
          : null,
        permalink
          ? el('a', { class: 'c-open', href: permalink, target: '_blank', rel: 'noopener noreferrer', title: 'Open this comment on Facebook' }, 'Open')
          : null,
      ),
      edits.length ? renderEdits(edits) : null,
    ),
  );
}

/** "Edited" marker with earlier versions. @param {{text: string, savedAt: string}[]} edits */
function renderEdits(edits) {
  return el(
    'details',
    { class: 'c-edits' },
    el(
      'summary',
      null,
      el('span', { class: 'badge tone-info' }, 'Edited'),
      ` ${plural(edits.length, 'earlier version')}`,
    ),
    el(
      'ol',
      { class: 'edit-list' },
      [...edits].reverse().map((v) =>
        el(
          'li',
          null,
          el('span', { class: 'edit-when' }, `Saved ${formatDate(v.savedAt)}`),
          el('div', { class: 'prose', dir: 'auto' }, v.text || ''),
        ),
      ),
    ),
  );
}

/** @param {any[]} attachments */
function renderAttachments(attachments) {
  if (!attachments.length) return null;
  const items = attachments
    .map((a) => {
      if (a?.type === 'image' && safeUrl(a.src)) {
        const img = el('img', {
          src: a.src,
          alt: a.alt || 'Image attachment',
          loading: 'lazy',
          decoding: 'async',
          referrerpolicy: 'no-referrer',
        });
        const link = el(
          'a',
          { class: 'att-img', href: safeUrl(a.href) || a.src, target: '_blank', rel: 'noopener noreferrer', title: 'Open image (Facebook image links can expire)' },
          img,
        );
        img.addEventListener('error', () => link.replaceChildren(el('span', { class: 'att-expired' }, 'Image link expired')), { once: true });
        return link;
      }
      if (a?.type === 'video') {
        return safeUrl(a.href)
          ? el('a', { class: 'att-chip', href: a.href, target: '_blank', rel: 'noopener noreferrer' }, icon(ICONS.video), 'Video')
          : el('span', { class: 'att-chip' }, icon(ICONS.video), 'Video');
      }
      const href = a?.href || a?.src;
      return safeUrl(href)
        ? el('a', { class: 'att-chip', href, target: '_blank', rel: 'noopener noreferrer', title: href }, icon(ICONS.link), linkLabel(href))
        : null;
    })
    .filter(Boolean);
  return items.length ? el('div', { class: 'c-attachments' }, items) : null;
}

/** @param {PostRecord} post @param {number} commentCount */
async function confirmDeletePost(post, commentCount) {
  const by = post.authorName ? ` by ${post.authorName}` : '';
  const ok = confirm(
    `Delete the post${by} and its ${plural(commentCount, 'saved comment')} from your archive?\n\nThis can’t be undone. The post on Facebook is not affected.`,
  );
  if (!ok) return;
  const visible = visiblePosts();
  const i = visible.findIndex((p) => p.id === post.id);
  const neighbour = visible[i + 1] ?? visible[i - 1] ?? null;
  try {
    await deletePost(post.id);
    notifyChanged([post.id]);
    state.selectedId = null;
    writeHash(null);
    await loadPosts();
    if (neighbour && state.postsById.has(neighbour.id)) await selectPost(neighbour.id);
    else renderIdle();
    showToast('Post deleted from the archive.', { tone: 'ok' });
  } catch (err) {
    showToast(`Couldn’t delete the post: ${errMsg(err)}`, { tone: 'danger' });
  }
}

/** Detail pane when nothing is selected. */
function renderIdle() {
  const detail = $('detail');
  if (!state.posts.length) {
    const groupLink = safeUrl(state.groupUrl)
      ? el('a', { class: 'btn btn-primary', href: state.groupUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open the group', icon(ICONS.external))
      : null;
    setDetail(
      detail,
      'empty',
      emptyView(
        ICONS.inbox,
        'No saved comments yet',
        'Open a post in the group and click “Save all comments” in the FB Comment Saver side panel. Saved posts appear here.',
        groupLink,
      ),
    );
    return;
  }
  setDetail(
    detail,
    'idle',
    emptyView(ICONS.select, 'Select a post', 'Choose a post on the left to read its comments, or search across every saved comment above.'),
  );
}

// =============================================================================================
// Search mode

const runSearchSoon = debounce(() => runSearch(), 250);

function onSearchInput() {
  const q = /** @type {HTMLInputElement} */ ($('search')).value.trim();
  if (!q) {
    exitSearch();
    return;
  }
  state.query = q;
  state.returnQuery = null;
  const detail = $('detail');
  if (detail.dataset.view !== 'search') setDetail(detail, 'loading', loadingView('Searching…'));
  runSearchSoon();
}

async function runSearch() {
  const q = state.query;
  if (!q) return;
  const token = ++searchToken;
  /** @type {CommentRecord[]} */
  let results;
  try {
    results = await searchComments(q, { limit: SEARCH_LIMIT });
  } catch (err) {
    if (token === searchToken) setDetail($('detail'), 'search', emptyView(ICONS.search, 'Search failed', errMsg(err)));
    return;
  }
  if (token !== searchToken || q !== state.query) return;
  state.results = [...(results || [])].sort((a, b) => byTimeDesc(a.createdAt, b.createdAt));
  renderSearchResults();
}

function renderSearchResults() {
  const q = state.query;
  const results = state.results;
  const detail = $('detail');
  const capped = results.length >= SEARCH_LIMIT;
  const view = el(
    'section',
    { class: 'search-view', 'aria-labelledby': 'search-heading' },
    el(
      'div',
      { class: 'sv-head' },
      el(
        'h2',
        { id: 'search-heading' },
        results.length ? `${capped ? `${SEARCH_LIMIT}+` : formatNumber(results.length)} ${results.length === 1 ? 'comment matches' : 'comments match'} “${q}”` : `No comments match “${q}”`,
      ),
      el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: clearSearchAndFocus }, 'Clear search'),
    ),
    capped ? el('p', { class: 'small muted sv-note' }, `Showing the first ${SEARCH_LIMIT} — add more words to narrow it down.`) : null,
    results.length
      ? el('ol', { class: 'results', role: 'list' }, results.map((c) => renderResult(c, q)))
      : emptyView(ICONS.search, 'Nothing found', 'Search looks at comment text and author names. Try another word or a shorter name.'),
  );
  const firstRender = detail.dataset.view !== 'search';
  setDetail(detail, 'search', view);
  if (firstRender) setScrollTop(detail, 0);
  announce(results.length ? `${plural(results.length, 'result')} for ${q}` : `No results for ${q}`);
}

/** @param {CommentRecord} c @param {string} q */
function renderResult(c, q) {
  const post = state.postsById.get(c.postId);
  const context = post
    ? `${post.authorName || 'Unknown author'}’s post${post.text ? ` · ${preview(post.text, 90)}` : ''}`
    : `Post ${c.postId}`;
  return el(
    'li',
    null,
    el(
      'button',
      { type: 'button', class: 'result', onclick: () => openResult(c) },
      el('span', { class: 'r-context', dir: 'auto' }, icon(ICONS.comment), context),
      el(
        'span',
        { class: 'r-head' },
        el('strong', { class: 'r-author', dir: 'auto' }, highlight(c.authorName || 'Unknown author', q)),
        c.isReply ? el('span', { class: 'badge' }, 'Reply') : null,
        c.missingAt ? el('span', { class: 'badge tone-danger' }, 'Not found in last full scan') : null,
        el('span', { class: 'r-date', title: c.createdAtText || null }, c.createdAt ? formatDate(c.createdAt) : c.createdAtText || ''),
      ),
      el('span', { class: 'r-text prose', dir: 'auto' }, highlight(snippet(c.text, q), q)),
    ),
  );
}

/** @param {CommentRecord} c */
function openResult(c) {
  const q = state.query;
  clearSearchState();
  state.returnQuery = q;
  selectPost(c.postId, { commentId: c.id, keepReturn: true });
}

function backToResults() {
  const q = state.returnQuery;
  state.returnQuery = null;
  if (!q) return;
  /** @type {HTMLInputElement} */ ($('search')).value = q;
  state.query = q;
  setDetail($('detail'), 'loading', loadingView('Searching…'));
  runSearch();
}

/** Resets search state without re-rendering the detail pane. */
function clearSearchState() {
  searchToken++;
  runSearchSoon.cancel();
  state.query = '';
  state.results = [];
  /** @type {HTMLInputElement} */ ($('search')).value = '';
}

/** Leaves search mode and shows the selected post (or the idle view). */
function exitSearch() {
  clearSearchState();
  if (state.selectedId) showPostDetail(state.selectedId);
  else renderIdle();
}

function clearSearchAndFocus() {
  exitSearch();
  $('search').focus();
}

// =============================================================================================
// Hash (deep links) & live refresh

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { postId: params.get('post'), commentId: params.get('comment') };
}

function writeHash(/** @type {string|null} */ postId) {
  const target = postId ? `#post=${encodeURIComponent(postId)}` : '';
  if (location.hash === target) return;
  history.replaceState(null, '', target || `${location.pathname}${location.search}`);
}

/** @type {Set<string>} */
let changedIds = new Set();
let changedAll = false;

const refreshSoon = debounce(async () => {
  const ids = changedIds;
  const all = changedAll;
  changedIds = new Set();
  changedAll = false;
  await loadPosts();
  if (state.query) {
    runSearch();
  } else if (state.selectedId) {
    if (all || ids.has(state.selectedId) || !state.postsById.has(state.selectedId)) {
      showPostDetail(state.selectedId, { preserveScroll: true });
    }
  } else if ($('detail').dataset.view === 'empty' || $('detail').dataset.view === 'idle') {
    renderIdle();
  }
}, 400);

/** @param {any} msg */
function onRuntimeMessage(msg) {
  if (!msg || msg.type !== MSG.DB_CHANGED) return undefined;
  if (Array.isArray(msg.postIds) && msg.postIds.length) for (const id of msg.postIds) changedIds.add(String(id));
  else changedAll = true;
  refreshSoon();
  return undefined; // no async response
}

// =============================================================================================
// Wiring

function isTypingTarget(/** @type {EventTarget|null} */ t) {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function bindEvents() {
  const search = /** @type {HTMLInputElement} */ ($('search'));
  search.addEventListener('input', onSearchInput);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.preventDefault();
      search.value = '';
      exitSearch();
    } else if (e.key === 'Enter') {
      runSearchSoon.flush();
    }
  });

  const filter = /** @type {HTMLInputElement} */ ($('filter'));
  const applyFilter = debounce(() => {
    state.filter = filter.value;
    renderPostList();
  }, 120);
  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filter.value) {
      filter.value = '';
      state.filter = '';
      renderPostList();
    }
  });

  const sort = /** @type {HTMLSelectElement} */ ($('sort'));
  sort.addEventListener('change', () => {
    state.sort = sort.value;
    renderPostList();
  });

  $('post-list').addEventListener('keydown', onListKeydown);

  for (const btn of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-export-all]'))) {
    btn.addEventListener('click', () => runExport(/** @type {'json'|'csv'|'md'} */ (btn.dataset.exportAll), undefined, btn));
  }
  $('btn-clear').addEventListener('click', confirmClearAll);

  // Skip link: focus the detail pane without touching the #post= hash.
  document.querySelector('.skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    $('detail').focus();
  });

  // "/" focuses search (when not already typing somewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(e.target)) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  // Deep links carry a nonce (#post=<id>&t=<ms>, see openLibrary) so that opening the same post
  // again still fires hashchange — e.g. to leave search results. selectPost writes the clean hash.
  window.addEventListener('hashchange', () => {
    const { postId, commentId } = readHash();
    if (postId && (postId !== state.selectedId || commentId || state.query)) selectPost(postId, { commentId });
    else if (postId) writeHash(postId);
  });

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  // Keep relative times ("saved 5 minutes ago") fresh.
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      renderStats();
      renderPostList();
    }
  }, 60_000);
}

async function init() {
  bindEvents();
  renderPostList(); // skeleton
  setDetail($('detail'), 'loading', loadingView('Loading archive…'));

  getSettings()
    .then((s) => {
      state.groupUrl = buildGroupFeedUrl(s);
      if ($('detail').dataset.view === 'empty') renderIdle();
    })
    .catch(() => {});

  await loadPosts();
  const { postId, commentId } = readHash();
  if (postId) await selectPost(postId, { commentId });
  else if (state.posts.length && WIDE.matches) await selectPost(visiblePosts()[0].id);
  else renderIdle();
}

init();
