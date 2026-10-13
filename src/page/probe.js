// Page script: cheap snapshot of the page state used by the Playwright driver (SPEC §4.3).
//
// HARD RULE: `probePage` is serialized with fn.toString() for page.evaluate() and
// chrome.scripting.executeScript(), so it must stay fully self-contained. Every helper is declared
// inside the function body, and nothing from module scope is referenced.

/**
 * @typedef {object} ProbeResult
 * @property {string} url
 * @property {'dialog'|'main'|'feed'|'none'} rootKind
 * @property {boolean} loginRequired   a visible login form and no post/feed root
 * @property {boolean} blocked         a small visible notice dialog (no articles, no chat text box)
 *                                     says the account is rate limited/blocked
 * @property {boolean} postArticleFound
 * @property {number} commentCount     comment/reply articles inside the root
 * @property {number} expanderCount    role=button inside the root matching expanderPattern
 * @property {number} seeMoreCount     role=button inside the root matching seeMorePattern
 * @property {string|null} sortLabel   text of the comment sort button ("Most relevant", "All comments", …)
 * @property {boolean} emptyState      "No comments yet"
 * @property {string|null} commentCountText
 * @property {boolean} feedbackFound   the post's "Leave a comment" button exists (with or without a
 *                                     number): its comment area (count, sort control) has rendered
 * @property {number} loadingCount     visible loading indicators ([role=progressbar],
 *                                     [data-visualcompletion=loading-state]) inside the root
 * @property {{found: boolean, scrollTop: number, scrollHeight: number, clientHeight: number}} scrollable
 *   the dialog's inner scroll container, or document.scrollingElement for other roots
 *   (found:false with the document's metrics when a dialog has no scroll container)
 */

/**
 * @param {{expanderPattern?: string, seeMorePattern?: string, sortButtonPattern?: string}} [opts]
 *   regex sources (compiled with flag 'i'); invalid or missing → built-in defaults
 *   (kept in sync with DEFAULT_SETTINGS in src/lib/constants.js).
 * @returns {ProbeResult}
 */
export function probePage(opts) {
  const o = opts || {};
  const DEFAULT_EXPANDER =
    '^(view|see)( all| more| previous)?( \\d[\\d,.]*[km]?)?( more| previous)? (comments?|repl(y|ies)|answers?)\\b|^\\d[\\d,.]*[km]? (more )?repl(y|ies)$';
  const DEFAULT_SEE_MORE = '^see more$';
  const DEFAULT_SORT = '^(most relevant|newest|all comments|top comments|most recent|oldest)$';
  const POST_SEL = '[role="article"]:not([aria-label])';
  const COMMENT_SEL = '[role="article"][aria-label]';
  const LOADING_SEL = '[role="progressbar"], [data-visualcompletion="loading-state"]';
  const BLOCKED_RE =
    /temporarily blocked|can.t use this feature right now|going too fast|try again later|we limit how often/i;
  // Facebook's block notices are short; a longer dialog is something else (e.g. a chat window).
  const BLOCK_NOTICE_MAX_CHARS = 800;

  function compile(source, fallback) {
    try {
      return new RegExp(source || fallback, 'i');
    } catch (e) {
      return new RegExp(fallback, 'i');
    }
  }
  const expanderRe = compile(o.expanderPattern, DEFAULT_EXPANDER);
  const seeMoreRe = compile(o.seeMorePattern, DEFAULT_SEE_MORE);
  const sortRe = compile(o.sortButtonPattern, DEFAULT_SORT);

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function labelOf(el) {
    return collapse(el.innerText || el.textContent);
  }

  function owned(article, selector) {
    return Array.from(article.querySelectorAll(selector)).filter((el) => el.closest('[role="article"]') === article);
  }

  function visible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  function findFeed() {
    const feeds = Array.from(document.querySelectorAll('[role="feed"]'));
    return feeds.find((f) => !f.closest('[role="dialog"]')) || feeds[0] || null;
  }

  function topLevelPosts(container) {
    return Array.from(container.querySelectorAll(POST_SEL)).filter((p) => {
      const ancestor = p.parentElement && p.parentElement.closest('[role="article"]');
      return !ancestor || !container.contains(ancestor);
    });
  }

  function topLevelPost(container) {
    return topLevelPosts(container)[0] || null;
  }

  function hasContent(post) {
    return /\S/.test(post.textContent || '') || !!post.querySelector('a[href]');
  }

  /**
   * [role=main] showing one post (a /permalink/ layout). Not a feed: a post URL loaded directly shows
   * the home or group feed in [role=main] until its dialog mounts, and that must never be the root.
   */
  function isPostMain(main) {
    return !main.querySelector('[role="feed"]') && topLevelPosts(main).filter(hasContent).length === 1;
  }

  function findRoot() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) =>
      d.querySelector(POST_SEL),
    );
    if (dialogs.length) return { kind: 'dialog', el: dialogs[dialogs.length - 1] };
    const main = document.querySelector('[role="main"]');
    if (/\/groups\/[^/]+\/(posts|permalink)\//.test(location.pathname) && main && isPostMain(main)) {
      return { kind: 'main', el: main };
    }
    const feed = findFeed();
    if (feed) return { kind: 'feed', el: feed };
    return { kind: 'none', el: null };
  }

  function hasEmptyStateText(scopeEl, post) {
    const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/^\s*no comments yet\.?\s*$/i.test(n.nodeValue || '')) continue;
      const article = n.parentElement && n.parentElement.closest('[role="article"]');
      if (article === post || (!article && scopeEl !== post)) return true;
    }
    return false;
  }

  function isScrollY(el) {
    const oy = getComputedStyle(el).overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
  }

  /** The dialog's inner scroll container: prefer an overflowing scroll ancestor of the post. */
  function findScroller(rootEl, post) {
    let fallback = null;
    if (post) {
      for (let el = post.parentElement; el && rootEl.contains(el); el = el.parentElement) {
        if (!isScrollY(el)) continue;
        if (el.scrollHeight > el.clientHeight + 1) return el;
        if (!fallback) fallback = el;
      }
    }
    if (fallback) return fallback;
    let best = null;
    for (const el of rootEl.querySelectorAll('div')) {
      if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0 && isScrollY(el)) {
        if (!best || el.clientHeight > best.clientHeight) best = el;
      }
    }
    return best;
  }

  const root = findRoot();
  const rootEl = root.el;
  const post = rootEl ? topLevelPost(rootEl) : null;
  // emptyState / commentCountText describe the opened post; they are not reported for the feed.
  const postView = !!post && (root.kind === 'dialog' || root.kind === 'main');

  const buttons = rootEl ? Array.from(rootEl.querySelectorAll('[role="button"]')) : [];
  let expanderCount = 0;
  let seeMoreCount = 0;
  let sortLabel = null;
  for (const b of buttons) {
    const label = labelOf(b);
    if (!label) continue;
    if (expanderRe.test(label)) expanderCount++;
    if (seeMoreRe.test(label)) seeMoreCount++;
    if (sortLabel === null && b.getAttribute('aria-haspopup') === 'menu' && sortRe.test(label)) sortLabel = label;
  }

  let commentCountText = null;
  let feedbackFound = false;
  if (postView) {
    for (const b of owned(post, '[role="button"][aria-label="Leave a comment"]')) {
      feedbackFound = true;
      const t = labelOf(b);
      if (/\d/.test(t)) {
        commentCountText = t;
        break;
      }
    }
  }
  const loadingCount = rootEl ? Array.from(rootEl.querySelectorAll(LOADING_SEL)).filter(visible).length : 0;

  const docEl = document.scrollingElement || document.documentElement;
  let scrollEl = docEl;
  let found = !!docEl;
  if (root.kind === 'dialog') {
    const inner = findScroller(rootEl, post);
    found = !!inner;
    if (inner) scrollEl = inner;
  }

  const loginVisible = Array.from(document.querySelectorAll('input[name="email"], form[action*="login"]')).some(visible);
  // A block notice is a small visible dialog. Not one that holds articles (a post, whose comments
  // may say "try again later"), a text box or message rows (a Messenger chat window), nor a hidden
  // or long one.
  const blocked = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some((d) => {
    if (!visible(d)) return false;
    if (d.querySelector('[role="article"], [role="textbox"], [contenteditable="true"], [role="grid"], [role="row"]')) {
      return false;
    }
    const text = collapse(d.innerText || d.textContent);
    return text.length <= BLOCK_NOTICE_MAX_CHARS && BLOCKED_RE.test(text);
  });

  return {
    url: location.href,
    rootKind: /** @type {ProbeResult['rootKind']} */ (root.kind),
    loginRequired: loginVisible && root.kind === 'none',
    blocked,
    postArticleFound: !!post,
    commentCount: rootEl ? rootEl.querySelectorAll(COMMENT_SEL).length : 0,
    expanderCount,
    seeMoreCount,
    sortLabel,
    emptyState: postView && hasEmptyStateText(rootEl, post),
    commentCountText,
    feedbackFound,
    loadingCount,
    scrollable: {
      found,
      scrollTop: Math.round(scrollEl ? scrollEl.scrollTop : 0),
      scrollHeight: scrollEl ? scrollEl.scrollHeight : 0,
      clientHeight: scrollEl ? scrollEl.clientHeight : 0,
    },
  };
}
