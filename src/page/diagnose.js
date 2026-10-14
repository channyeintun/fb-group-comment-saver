// Page script: privacy-safe structural report of the open Facebook page (SPEC §4.5), for the side
// panel's "Copy diagnostics" button. Facebook serves different markup to different accounts; this
// tells us which variant a user got without seeing their data.
//
// PRIVACY: the report holds no names, post/comment text, numeric ids or full URLs. URLs are reduced
// to masked shapes (group slug → {g}, digit runs of 5+ → {n}, other path segments → {s}, query
// KEYS only), texts to "len<n>:<classes>" shapes.
//
// HARD RULE: `diagnosePage` is serialized with fn.toString() for chrome.scripting.executeScript()
// and page.evaluate(), so it must stay fully self-contained (no references outside its body).
// Run it in the MAIN world, or React data (fibers) is reported as unreachable.

/**
 * @param {{expanderPattern?: string, seeMorePattern?: string, sortButtonPattern?: string}} [opts]
 * @returns {object} JSON-serializable report
 */
export function diagnosePage(opts) {
  const o = opts || {};
  const DEFAULTS = {
    expander:
      '^(view|see)( all| more| previous)?( \\d[\\d,.]*[km]?)?( more| previous)? (comments?|repl(y|ies)|answers?)\\b|^\\d[\\d,.]*[km]? (more )?repl(y|ies)$',
    seeMore: '^see more$',
    sortButton: '^(most relevant|newest|all comments|top comments|most recent|oldest)$',
  };
  function compile(src, fallback) {
    try {
      return new RegExp(src || fallback, 'i');
    } catch (e) {
      return new RegExp(fallback, 'i');
    }
  }
  const PATTERNS = {
    expander: compile(o.expanderPattern, DEFAULTS.expander),
    seeMore: compile(o.seeMorePattern, DEFAULTS.seeMore),
    sortButton: compile(o.sortButtonPattern, DEFAULTS.sortButton),
  };
  const MESSAGE_SEL =
    '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
  // A container holding a post article (same rule as extractRaw / pw-driver): an article without
  // aria-label, or one with post sub-parts.
  const ROOT_POST_SEL =
    '[role="article"]:not([aria-label]), [role="article"] [data-ad-rendering-role], ' +
    '[role="article"] [data-ad-preview="message"], [role="article"] [data-ad-comet-preview="message"]';
  const SAFE_SEGMENT_RE =
    /^(groups|user|posts|permalink|photo|photos|photo\.php|profile\.php|story\.php|permalink\.php|l\.php|hashtag|watch|events|reel|reels|share|pages|people|media|set|videos|stories|commerce|buy_sell_discussion|discussion|members|about|media_set)$/i;

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }
  function mask(s) {
    return String(s == null ? '' : s).replace(/\d{5,}/g, '{n}');
  }
  /** a.href as a string; '' for a lazy link ("#…", empty, javascript:), which a.href would resolve to the page URL. */
  function hrefOf(a) {
    if (!a) return '';
    const raw = (a.getAttribute('href') || a.getAttribute('xlink:href') || '').trim();
    if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return '';
    const h = a.href;
    if (typeof h === 'string') return h;
    return (h && h.baseVal) || raw;
  }

  // ---- shapes ----------------------------------------------------------------------------------

  function textShape(t) {
    const s = collapse(t);
    const cls = [];
    if (/\d/.test(s)) cls.push('digit');
    if (/[A-Za-z]/.test(s)) cls.push('alpha');
    if (/[^\x00-\x7F]/.test(s)) cls.push('other');
    if (/\s/.test(s)) cls.push('space');
    if (/[!-/:-@[-`{-~]/.test(s)) cls.push('punct');
    return 'len' + Array.from(s).length + (cls.length ? ':' + cls.join('+') : '');
  }

  function pathShape(pathname) {
    const segs = String(pathname || '').split('/');
    return segs
      .map((seg, i) => {
        if (!seg) return seg;
        if (i > 0 && segs[i - 1] === 'groups') return '{g}';
        if (/^\d+$/.test(seg)) return seg.length >= 5 ? '{n}' : seg;
        if (SAFE_SEGMENT_RE.test(seg)) return seg.toLowerCase();
        return '{s}';
      })
      .join('/');
  }

  function queryKeys(u) {
    const keys = [];
    u.searchParams.forEach((v, k) => {
      if (/^__/.test(k)) return;
      const key = /^[a-z_]{1,30}$/i.test(k) ? k : '{k}';
      if (keys.indexOf(key) === -1) keys.push(key);
    });
    return keys;
  }

  function urlShape(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (t === '') return 'empty';
    if (t === '#') return '#';
    if (/^javascript:/i.test(t)) return 'javascript:';
    let u;
    try {
      u = new URL(t, location.href);
    } catch (e) {
      return 'invalid';
    }
    const host = /(^|\.)facebook\.com$/i.test(u.hostname) ? '' : 'ext:';
    const keys = queryKeys(u);
    return host + pathShape(u.pathname) + (keys.length ? '?' + keys.join('&') : '') + (u.hash && u.hash !== '#' ? '#…' : '');
  }

  function linkShape(a, where) {
    const raw = a.getAttribute('href');
    return {
      where,
      href: raw == null ? 'none' : urlShape(raw),
      text: textShape(a.textContent),
      ariaLabel: a.hasAttribute('aria-label'),
      labelledby: a.hasAttribute('aria-labelledby'),
      tabindex: /^-?\d$/.test(a.getAttribute('tabindex') || '') ? a.getAttribute('tabindex') : null,
    };
  }

  // ---- React fibers (MAIN world only) ----------------------------------------------------------

  function fiberOf(el) {
    try {
      const key = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
      return key ? el[key] : null;
    } catch (e) {
      return null;
    }
  }
  function b64(s) {
    if (typeof s !== 'string' || s.length < 8 || s.length > 400 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return null;
    try {
      return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    } catch (e) {
      return null;
    }
  }
  /** Depth (≤ 80) at which a feed story id ("S:_I…:VK:<id>") is found walking up, else null. */
  function fiberStoryDepth(el) {
    let f = fiberOf(el);
    for (let i = 0; f && i < 80; i++) {
      try {
        const props = f.memoizedProps;
        if (props && typeof props === 'object') {
          for (const key of Object.keys(props)) {
            let v;
            try {
              v = props[key];
            } catch (e) {
              continue;
            }
            if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
            if (/^S:_I\d+:VK:\d+/.test(b64(v.id) || b64(v.__id) || '')) return i;
          }
        }
        f = f.return;
      } catch (e) {
        return null;
      }
    }
    return null;
  }
  function fiberComment(el) {
    let f = fiberOf(el);
    for (let i = 0; f && i < 6; i++) {
      try {
        const p = f.memoizedProps;
        if (p && p.comment && typeof p.comment === 'object') return p.comment;
        f = f.return;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // ---- structure -------------------------------------------------------------------------------

  function hasContent(el) {
    return /\S/.test(el.textContent || '') || !!el.querySelector('a[href]');
  }
  function isCommentLike(article) {
    try {
      const own = (el) => el.closest('[role="article"]') === article;
      if (Array.from(article.querySelectorAll(MESSAGE_SEL + ', [data-ad-rendering-role]')).some(own)) return false;
      return (
        Array.from(article.querySelectorAll('a')).some((a) => own(a) && /[?&](reply_)?comment_id=/.test(hrefOf(a))) ||
        !!fiberComment(article)
      );
    } catch (e) {
      return false;
    }
  }
  function ownedBy(el, container) {
    const a = el.closest('[role="article"]');
    if (a === container) return true;
    if (container.getAttribute('role') === 'article') return false;
    return !a || !container.contains(a) || !isCommentLike(a);
  }
  function containersOf(feed) {
    const articles = Array.from(feed.querySelectorAll('[role="article"]')).filter((a) => {
      const ancestor = a.parentElement && a.parentElement.closest('[role="article"]');
      return !(ancestor && feed.contains(ancestor)) && !isCommentLike(a);
    });
    if (articles.length || !hasContent(feed)) return { mode: 'article', list: articles };
    return { mode: 'children', list: Array.from(feed.children) };
  }

  function containerAttrs(el) {
    return {
      tag: String(el.tagName || '').toLowerCase(),
      role: el.getAttribute('role') || null,
      ariaLabel: el.hasAttribute('aria-label'),
      labelledby: el.hasAttribute('aria-labelledby'),
      posinset: el.hasAttribute('aria-posinset'),
      describedby: el.hasAttribute('aria-describedby'),
    };
  }

  function buttonInfo(root) {
    const buttons = Array.from(root.querySelectorAll('[role="button"]'));
    const shapes = {};
    let distinct = 0;
    let expanders = 0;
    let seeMore = 0;
    let sort = 0;
    for (const b of buttons) {
      const t = collapse(b.innerText || b.textContent);
      if (PATTERNS.expander.test(t)) expanders++;
      if (PATTERNS.seeMore.test(t)) seeMore++;
      if (b.getAttribute('aria-haspopup') === 'menu' && PATTERNS.sortButton.test(t)) sort++;
      if (!b.hasAttribute('aria-label') && t) {
        const shape = textShape(t);
        if (!(shape in shapes)) {
          if (distinct >= 20) continue;
          distinct++;
          shapes[shape] = 0;
        }
        shapes[shape]++;
      }
    }
    return {
      buttons: buttons.length,
      expanderMatches: expanders,
      seeMoreMatches: seeMore,
      sortButtonMatches: sort,
      menuButtons: root.querySelectorAll('[role="button"][aria-haspopup="menu"]').length,
      unlabelledTextShapes: shapes,
    };
  }

  function postInfo(post, extra) {
    const story =
      Array.from(post.querySelectorAll(MESSAGE_SEL)).find((el) => ownedBy(el, post)) || null;
    const links = Array.from(post.querySelectorAll('a')).filter((a) => {
      if (!ownedBy(a, post)) return false;
      const m = a.closest(MESSAGE_SEL);
      return !(m && post.contains(m));
    });
    const before = story
      ? links.filter((a) => !!(story.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING))
      : links;
    const after = story ? links.filter((a) => before.indexOf(a) === -1) : [];
    const comments = Array.from(post.querySelectorAll('[role="article"]')).filter(
      (a) =>
        a !== post &&
        !a.querySelector(MESSAGE_SEL + ', [data-ad-rendering-role]') &&
        (a.hasAttribute('aria-label') || isCommentLike(a)),
    );
    let withPermalink = 0;
    let withFiberId = 0;
    let withFiberAuthor = 0;
    let labelled = 0;
    for (const c of comments) {
      if (c.hasAttribute('aria-label')) labelled++;
      if (Array.from(c.querySelectorAll('a')).some((a) => a.closest('[role="article"]') === c && /[?&](reply_)?comment_id=/.test(hrefOf(a)))) {
        withPermalink++;
      }
      const fc = fiberComment(c);
      if (fc && /^\d+$/.test(String(fc.legacy_fbid == null ? '' : fc.legacy_fbid))) withFiberId++;
      if (fc && fc.author && /^\d+$/.test(String(fc.author.id == null ? '' : fc.author.id))) withFiberAuthor++;
    }
    const roles = {};
    Array.from(post.querySelectorAll('[data-ad-rendering-role]')).forEach((el) => {
      const r = String(el.getAttribute('data-ad-rendering-role')).replace(/[^\w-]/g, '').slice(0, 30);
      roles[r] = (roles[r] || 0) + 1;
    });
    const depth = fiberStoryDepth(post);
    let headerDepth = null;
    for (const a of before.slice(0, 6)) {
      headerDepth = fiberStoryDepth(a);
      if (headerDepth !== null) break;
    }
    const info = {
      container: containerAttrs(post),
      hasContent: hasContent(post),
      story: !!story,
      renderingRoles: roles,
      links: links.length,
      headerLinks: before.slice(0, 8).map((a) => linkShape(a, 'header')),
      afterBodyLinks: after.slice(0, 4).map((a) => linkShape(a, 'after')),
      fiberReachable: !!fiberOf(post),
      fiberPostIdFound: depth !== null || headerDepth !== null,
      fiberPostIdDepth: depth !== null ? depth : headerDepth,
      comments: {
        count: comments.length,
        withAriaLabel: labelled,
        withPermalink,
        withFiberId,
        withFiberAuthor,
      },
    };
    return Object.assign(info, extra || {});
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback !== undefined ? fallback : { error: mask(String((e && e.name) || 'error')) };
    }
  }

  // ---- report ----------------------------------------------------------------------------------

  const report = {};
  report.url = safe(() => {
    const u = new URL(location.href);
    const host = u.hostname.toLowerCase();
    return {
      host: /(^|\.)facebook\.com$/.test(host) ? host.replace(/^([a-z]+)\.facebook\.com$/, '$1') : 'other',
      path: pathShape(u.pathname),
      query: queryKeys(u),
    };
  });
  report.lang = mask((document.documentElement.getAttribute('lang') || '').slice(0, 20)) || null;
  report.dir = (document.documentElement.getAttribute('dir') || '').slice(0, 5) || null;
  report.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  report.visibility = document.visibilityState;

  const feedsAll = Array.from(document.querySelectorAll('[role="feed"]'));
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  const postDialogs = dialogs.filter((d) => !!d.querySelector('[role="article"]'));
  const main = document.querySelector('[role="main"]');
  report.counts = safe(() => ({
    feeds: feedsAll.length,
    feedsInDialogs: feedsAll.filter((f) => !!f.closest('[role="dialog"]')).length,
    dialogs: dialogs.length,
    dialogsWithArticles: postDialogs.length,
    mains: document.querySelectorAll('[role="main"]').length,
    articles: document.querySelectorAll('[role="article"]').length,
    articlesWithAriaLabel: document.querySelectorAll('[role="article"][aria-label]').length,
    articlesWithLabelledby: document.querySelectorAll('[role="article"][aria-labelledby]').length,
    articlesWithPosinset: document.querySelectorAll('[role="article"][aria-posinset]').length,
    storyMessages: document.querySelectorAll('[data-ad-rendering-role="story_message"]').length,
    commentIdLinks: document.querySelectorAll('a[href*="comment_id="]').length,
    postLinks: Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"]')).length,
    lazyLinks: document.querySelectorAll('a[href="#"], a:not([href])').length,
    fiberNodes: Array.from(document.querySelectorAll('[role="article"], [role="feed"]')).filter((el) => !!fiberOf(el)).length,
  }));

  // Root kind (same rules as extractRaw's findRoot).
  report.rootKind = safe(() => {
    if (dialogs.some((d) => d.querySelector(ROOT_POST_SEL))) return 'dialog';
    if (/\/groups\/[^/]+\/(posts|permalink)\//.test(location.pathname) && main && !main.querySelector('[role="feed"]')) {
      return 'main';
    }
    return feedsAll.length ? 'feed' : 'none';
  }, 'none');

  report.feeds = safe(() =>
    feedsAll.slice(0, 4).map((feed) => {
      const c = containersOf(feed);
      return {
        inDialog: !!feed.closest('[role="dialog"]'),
        children: feed.children.length,
        childrenWithContent: Array.from(feed.children).filter(hasContent).length,
        containerMode: c.mode,
        containers: c.list.length,
        rendered: c.list.filter(hasContent).length,
        fiberReachable: !!fiberOf(feed),
      };
    }),
  );

  report.feedPosts = safe(() => {
    const out = [];
    let feeds = feedsAll.filter((f) => !f.closest('[role="dialog"]'));
    if (!feeds.length) feeds = feedsAll;
    for (const feed of feeds) {
      for (const post of containersOf(feed).list.filter(hasContent)) {
        if (out.length >= 5) break;
        out.push(safe(() => postInfo(post)));
      }
    }
    return out;
  }, []);

  report.dialog = safe(() => {
    const dlg = dialogs.filter((d) => d.querySelector(ROOT_POST_SEL)).pop() || null;
    if (!dlg) return null;
    const post = Array.from(dlg.querySelectorAll('[role="article"]')).find((a) => {
      const ancestor = a.parentElement && a.parentElement.closest('[role="article"]');
      return (
        !(ancestor && dlg.contains(ancestor)) &&
        (!a.hasAttribute('aria-label') || !!a.querySelector(MESSAGE_SEL + ', [data-ad-rendering-role]'))
      );
    });
    return {
      container: containerAttrs(dlg),
      post: post ? postInfo(post) : null,
      controls: buttonInfo(dlg),
      progressbars: dlg.querySelectorAll('[role="progressbar"]').length,
    };
  }, null);

  report.page = safe(() => ({
    controls: buttonInfo(document.body),
    // Attribute NAMES on <html>/<body> (other extensions often add their own).
    htmlAttrs: Array.from(document.documentElement.attributes).map((a) => mask(a.name).slice(0, 40)).slice(0, 20),
    bodyAttrs: Array.from(document.body.attributes).map((a) => mask(a.name).slice(0, 40)).slice(0, 20),
    extensionNodes: document.querySelectorAll('[src^="chrome-extension://"], [href^="chrome-extension://"]').length,
  }));

  return report;
}
