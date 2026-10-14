// Page script: read posts, comments and replies from the open Facebook page (SPEC §4.1).
//
// HARD RULE: `extractRaw` is serialized with fn.toString() for page.evaluate() and
// chrome.scripting.executeScript(), so it must stay fully self-contained. Every helper is declared
// inside the function body, and nothing from module scope (imports, constants, other functions) is
// referenced. Do not minify this file or use keepNames on it.

/**
 * @typedef {{type: 'image'|'video'|'link', src?: string, href?: string|null, alt?: string}} RawAttachment
 *
 * @typedef {object} RawComment
 * @property {number} index              0-based DOM order within the post
 * @property {string} ariaLabel          e.g. "Comment by X 2 days ago" / "Reply by X to Y's comment 1d"
 * @property {string|null} authorName
 * @property {string|null} authorHref
 * @property {string|null} permalinkHref absolute href of the timestamp link (contains comment_id)
 * @property {string|null} timeAria      absolute date from the timestamp link's aria-label
 * @property {string|null} timeText      visible relative time, e.g. "2d"
 * @property {string} text               body text ('' for sticker/image-only comments)
 * @property {number} left               rounded getBoundingClientRect().left (encodes depth)
 * @property {string|null} reactionLabel e.g. "5 reactions; see who reacted to this"
 * @property {boolean} truncated         a "See more" toggle is still present
 * @property {RawAttachment[]} attachments
 * @property {string|null} fiberCommentId  React data (MAIN world only): comment.legacy_fbid — own id
 * @property {string|null} fiberPostId     from comment.id = base64("comment:<postId>_<ownId>")
 * @property {string|null} fiberAuthorId   comment.author.id when numeric
 * @property {string|null} fiberAuthorName comment.author.name
 *
 * @typedef {object} RawPost
 * @property {string|null} permalinkHref
 * @property {string|null} authorName
 * @property {string|null} authorHref
 * @property {string} text
 * @property {string|null} dateText
 * @property {string|null} dateAria
 * @property {string|null} commentCountText
 * @property {boolean} emptyState
 * @property {string|null} fiberPostId  React data (MAIN world only): the feed story id's post id
 * @property {RawComment[]} items
 *
 * @typedef {object} RawExtraction
 * @property {string} pageUrl
 * @property {string} pageTitle
 * @property {'dialog'|'main'|'feed'|'none'} rootKind
 * @property {number} extractedAt
 * @property {RawPost[]} posts
 */

/**
 * Extract the post(s) and comment articles currently in the DOM. Never clicks, scrolls or mutates.
 *
 * - scope 'auto' (default): the open post dialog, else the post page's [role=main], else the feed.
 * - scope 'feed': every rendered top-level post in the group feed (comment previews only).
 *
 * @param {{scope?: 'auto'|'feed'}} [opts]
 * @returns {RawExtraction}
 */
export function extractRaw(opts) {
  const scope = opts && opts.scope === 'feed' ? 'feed' : 'auto';

  const COMMENT_SEL = '[role="article"][aria-label]';
  const POST_LINK_RE = /\/groups\/[^/]+\/(posts|permalink)\/[\w.-]+/;
  const POST_ID_RE = /\/groups\/[^/]+\/(?:posts|permalink)\/([\w.-]+)/;
  // The post body. Links in it (pasted URLs, mentions) are never the post's own links.
  const MESSAGE_SEL =
    '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
  // Post sub-parts (body, profile_name, like/comment/share buttons). Comments never own one; a post
  // article does, with or without an aria-label.
  const POST_PARTS_SEL = MESSAGE_SEL + ', [data-ad-rendering-role]';
  // A container holding a post article (dialog/main root selection, SPEC §4): an article without
  // aria-label, or one with post sub-parts. Same selector as pw-driver's root locators.
  const ROOT_POST_SEL =
    '[role="article"]:not([aria-label]), [role="article"] [data-ad-rendering-role], ' +
    '[role="article"] [data-ad-preview="message"], [role="article"] [data-ad-comet-preview="message"]';
  // Relative time at the end of a comment aria-label ("… 2 days ago", "… 5h").
  const ARIA_TIME_TAIL = /\s+(?:just now|a few seconds ago|(?:\d+|an?)\s?[a-z]+(?:\s+ago)?)$/i;
  // First path segments that look like a vanity name but are never a profile.
  const RESERVED_SEGMENT_RE =
    /^(groups|profile\.php|photo|photo\.php|photos|watch|events|hashtag|l\.php|story\.php|permalink\.php|pages|people|reel|reels|share|stories|marketplace|gaming|notifications|messages|friends|bookmarks|search|login|help|privacy|policies)$/i;
  const DATE_RES = [
    /^(\d{1,2} \w+( \d{4})?|\w+ \d{1,2}(, \d{4})?|yesterday|today) at \d{1,2}:\d{2}( ?[ap]m)?$/i,
    /^\d+\s?[smhdwy]$/,
    /^(just now|\d+ \w+ ago|an? \w+ ago)$/i,
  ];

  /** Collapse whitespace runs to one space and trim. */
  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /**
   * a.href as a string (SVG <a> elements expose an SVGAnimatedString); '' for a lazy link. Facebook
   * renders some links as href "#" (or empty / javascript:) until hovered, and a.href resolves "#" to
   * the page URL — which names the open post, and on a notification URL even carries ?comment_id=.
   */
  function hrefOf(a) {
    if (!a) return '';
    const raw = (a.getAttribute('href') || a.getAttribute('xlink:href') || '').trim();
    if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return '';
    const h = a.href;
    if (typeof h === 'string') return h;
    return (h && h.baseVal) || raw;
  }

  // ---- React fiber data (visible only from the page's MAIN world; null elsewhere) -------------

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

  /** Post id of a feed story object: its id is base64 of "S:_I<digits>:VK:<postId>". */
  function storyPostId(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    for (const key of ['id', '__id']) {
      let v;
      try {
        v = value[key];
      } catch (e) {
        continue;
      }
      const m = /^S:_I\d+:VK:(\d+)/.exec(b64(v) || '');
      if (m) return m[1];
    }
    return null;
  }

  /** Walks up the fiber tree from `el` (≤ 80 levels, never past `stopEl`'s fiber). */
  function fiberPostId(el, stopEl) {
    let f = fiberOf(el);
    for (let i = 0; f && i < 80; i++) {
      try {
        if (stopEl && f.stateNode === stopEl) return null;
        const props = f.memoizedProps;
        if (props && typeof props === 'object') {
          const keys = Object.keys(props).sort((a, b) => (b === 'feedUnit') - (a === 'feedUnit'));
          for (const key of keys) {
            let v;
            try {
              v = props[key];
            } catch (e) {
              continue;
            }
            const id = storyPostId(v);
            if (id) return id;
          }
        }
        f = f.return;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /** memoizedProps.comment of a comment article's fiber (a few levels up), else null. */
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

  /** Fiber fields of a comment article; every field null when unavailable. */
  function commentFiberFields(article) {
    const out = { fiberCommentId: null, fiberPostId: null, fiberAuthorId: null, fiberAuthorName: null };
    try {
      const c = fiberComment(article);
      if (!c) return out;
      const own = c.legacy_fbid != null ? String(c.legacy_fbid) : '';
      if (/^\d+$/.test(own)) out.fiberCommentId = own;
      const m = /^comment:(\d+)_(\d+)/.exec(b64(String(c.id || '')) || '');
      if (m) {
        out.fiberPostId = m[1];
        if (!out.fiberCommentId) out.fiberCommentId = m[2];
      }
      const author = c.author && typeof c.author === 'object' ? c.author : null;
      if (author) {
        const id = author.id != null ? String(author.id) : '';
        if (/^\d+$/.test(id)) out.fiberAuthorId = id;
        if (typeof author.name === 'string' && author.name.trim()) out.fiberAuthorName = author.name.trim();
      }
    } catch (e) {
      // keep nulls
    }
    return out;
  }

  const postPartsCache = new Map();
  /** The article owns a post sub-part (not one of a nested article). */
  function ownsPostParts(article) {
    if (postPartsCache.has(article)) return postPartsCache.get(article);
    let result = false;
    try {
      result = Array.from(article.querySelectorAll(POST_PARTS_SEL)).some((el) => el.closest('[role="article"]') === article);
    } catch (e) {
      result = false;
    }
    postPartsCache.set(article, result);
    return result;
  }

  const commentLikeCache = new Map();
  /**
   * A comment article: its own links carry comment_id, or its fiber has a `comment` prop — and it
   * has no post sub-parts (body, like/comment buttons). Same rule as collectFeedPosts.
   */
  function isCommentLike(article) {
    if (commentLikeCache.has(article)) return commentLikeCache.get(article);
    let result = false;
    try {
      if (!ownsPostParts(article)) {
        const own = (el) => el.closest('[role="article"]') === article;
        result =
          Array.from(article.querySelectorAll('a')).some((a) => own(a) && hrefOf(a).indexOf('comment_id') !== -1) ||
          !!fiberComment(article);
      }
    } catch (e) {
      result = false;
    }
    commentLikeCache.set(article, result);
    return result;
  }

  /**
   * A comment/reply article: no post sub-parts, and an aria-label (SPEC §1) or comment signals
   * (isCommentLike). A post article owns post sub-parts whether or not it has an aria-label.
   */
  function isCommentArticle(article) {
    return !ownsPostParts(article) && (article.hasAttribute('aria-label') || isCommentLike(article));
  }

  /** A post article for dialog/main roots: no aria-label, or an aria-label and post sub-parts. */
  function isRootPost(article) {
    return !article.hasAttribute('aria-label') || ownsPostParts(article);
  }

  /**
   * The article an element belongs to: the nearest article above it that is `post` or not a
   * comment (comment articles are flat, so a comment's owner is the post around it).
   */
  function owningArticle(el, post) {
    let a = el.parentElement && el.parentElement.closest('[role="article"]');
    while (a && a !== post && isCommentArticle(a)) a = a.parentElement && a.parentElement.closest('[role="article"]');
    return a || null;
  }

  /**
   * The element belongs to `container` itself: for an article, not to an article nested inside it;
   * for a role-less feed post container, not to one of its comment articles.
   */
  function ownedBy(el, container) {
    const a = el.closest('[role="article"]');
    if (a === container) return true;
    if (container.getAttribute('role') === 'article') return false;
    return !a || !container.contains(a) || !isCommentLike(a);
  }

  function owned(article, selector) {
    return Array.from(article.querySelectorAll(selector)).filter((el) => ownedBy(el, article));
  }

  /**
   * Visible-ish text by walking child nodes (works off-screen and in hidden nodes, unlike
   * innerText): <img alt> → alt, <br> → hard line break, block elements (every div[dir=auto]
   * paragraph) → line break, whitespace collapsed inside lines, lines trimmed, at most one blank
   * line in a row. "See more"/"See less" toggle buttons are left out.
   */
  function textOf(root) {
    if (!root) return '';
    const BLOCK_RE =
      /^(DIV|P|LI|UL|OL|DL|DT|DD|H[1-6]|BLOCKQUOTE|PRE|TABLE|TBODY|THEAD|TFOOT|TR|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|FIGURE|FIGCAPTION|HR)$/;
    const SKIP_RE = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|VIDEO|AUDIO|CANVAS|SELECT|TEXTAREA|INPUT)$/;
    const parts = [];
    let atLineStart = true;
    const emit = (s) => {
      if (!s) return;
      parts.push(s);
      if (/\S/.test(s)) atLineStart = false;
    };
    const softBreak = () => {
      if (!atLineStart) {
        parts.push('\n');
        atLineStart = true;
      }
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        emit(node.nodeValue.replace(/\s+/g, ' '));
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.tagName).toUpperCase();
      if (tag === 'IMG') {
        emit(node.getAttribute('alt') || '');
        return;
      }
      if (tag === 'BR') {
        parts.push('\n');
        atLineStart = true;
        return;
      }
      if (SKIP_RE.test(tag)) return;
      if (node.getAttribute('role') === 'button' && /^see (more|less)$/i.test(collapse(node.textContent))) {
        return;
      }
      const block = BLOCK_RE.test(tag);
      if (block) softBreak();
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
      if (block) softBreak();
    };
    walk(root);
    return parts
      .join('')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Profile link: /user/<id>, profile.php?id=, or a facebook.com/<vanity> top-level path. */
  function isProfileHref(href) {
    if (!href) return false;
    if (/\/user\/\d+|profile\.php\?id=/.test(href)) return true;
    const m = href.match(/^https?:\/\/([^/]+)\/([\w.]+)\/?(\?|#|$)/);
    return !!m && /(^|\.)facebook\.com$/i.test(m[1]) && !RESERVED_SEGMENT_RE.test(m[2]);
  }

  function stripQuery(href) {
    return String(href || '').split(/[?#]/)[0];
  }

  function findFeed() {
    const feeds = Array.from(document.querySelectorAll('[role="feed"]'));
    return feeds.find((f) => !f.closest('[role="dialog"]')) || feeds[0] || null;
  }

  /** Every [role=feed] outside dialogs (fallback: all), outermost only. */
  function allFeeds() {
    const all = Array.from(document.querySelectorAll('[role="feed"]'));
    let feeds = all.filter((f) => !f.closest('[role="dialog"]'));
    if (!feeds.length) feeds = all;
    return feeds.filter((f) => !feeds.some((other) => other !== f && other.contains(f)));
  }

  /**
   * Rendered feed posts with their feed (SPEC §4.2 container rules): top-level non-comment
   * articles; a feed with content but no such article → its children (role-less post variant).
   */
  function feedPosts() {
    const out = [];
    for (const feed of allFeeds()) {
      const articles = Array.from(feed.querySelectorAll('[role="article"]')).filter((a) => {
        const ancestor = a.parentElement && a.parentElement.closest('[role="article"]');
        return !(ancestor && feed.contains(ancestor)) && !isCommentLike(a);
      });
      let list = articles;
      if (!articles.length && hasContent(feed)) {
        let parent = feed;
        for (let i = 0; i < 4; i++) {
          const kids = Array.from(parent.children).filter(hasContent);
          if (kids.length === 1 && kids[0].children.length > 1 && kids[0].getAttribute('role') !== 'article') {
            parent = kids[0];
          } else break;
        }
        list = Array.from(parent.children);
      }
      for (const post of list) if (hasContent(post)) out.push({ post, feed });
    }
    return out;
  }

  /** Post articles (isRootPost) with no ancestor article inside `container`. */
  function topLevelPosts(container) {
    return Array.from(container.querySelectorAll('[role="article"]')).filter((p) => {
      const ancestor = p.parentElement && p.parentElement.closest('[role="article"]');
      return (!ancestor || !container.contains(ancestor)) && isRootPost(p);
    });
  }

  /** Virtualized feed posts keep their wrapper but have no text and no links. */
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

  /** SPEC §4 root selection: last dialog holding a post article, single-post main, feed, none. */
  function findRoot() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((d) =>
      d.querySelector(ROOT_POST_SEL),
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

  /** Author name from "Comment by X 2 days ago" / "Reply by X to Y's comment 1d" (English UI). */
  function nameFromAria(label) {
    const m = /^(?:comment|reply) by (.+)$/i.exec(collapse(label));
    if (!m) return null;
    let rest = m[1].replace(ARIA_TIME_TAIL, '');
    const reply = /^(.+?) to .+['’]s (?:comment|reply)$/i.exec(rest);
    if (/^reply by/i.test(collapse(label)) && reply) rest = reply[1];
    return rest.trim() || null;
  }

  /** `a` comes before `b` in document order. */
  function precedes(a, b) {
    return !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  /** "No comments yet" owned by the post (or loose inside the dialog/main root, outside articles). */
  function hasEmptyStateText(scopeEl, post) {
    const walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/^\s*no comments yet\.?\s*$/i.test(n.nodeValue || '')) continue;
      const article = n.parentElement && n.parentElement.closest('[role="article"]');
      if (article === post || (!article && scopeEl !== post)) return true;
    }
    return false;
  }

  /** @returns {RawComment} */
  function extractComment(article, index) {
    const links = owned(article, 'a');
    const isCommentLink = (a) => hrefOf(a).indexOf('comment_id') !== -1;
    const fiber = commentFiberFields(article);

    // Body: span/div[dir=auto] outside links and buttons that holds div[dir=auto] paragraphs;
    // otherwise the candidate with the most text. Keep only the top-most matches.
    const cache = new Map();
    const cachedText = (el) => {
      if (!cache.has(el)) cache.set(el, textOf(el));
      return cache.get(el);
    };
    const candidates = owned(article, 'span[dir="auto"], div[dir="auto"]').filter(
      (el) => !el.closest('a') && !el.closest('[role="button"]'),
    );
    let bodies = candidates.filter((el) =>
      Array.prototype.some.call(el.children, (child) => child.matches('div[dir="auto"]')),
    );
    if (!bodies.length) {
      let best = null;
      for (const el of candidates) {
        if (cachedText(el).length > (best ? cachedText(best).length : 0)) best = el;
      }
      if (best) bodies = [best];
    }
    bodies = bodies.filter((el) => !bodies.some((other) => other !== el && other.contains(el)));
    const text = bodies.map(cachedText).filter(Boolean).join('\n');
    const inBody = (el) => bodies.some((b) => b.contains(el));

    // Permalink: the timestamp link, a comment_id link outside the body (a link to another comment
    // pasted in the text is never it). With React data, only a link naming the comment's own id
    // (reply_comment_id, else comment_id): any other comment link belongs to something else.
    const ownIdOf = (a) => {
      try {
        const u = new URL(hrefOf(a));
        return u.searchParams.get('reply_comment_id') || u.searchParams.get('comment_id');
      } catch (e) {
        return null;
      }
    };
    const permA =
      links.find(
        (a) => isCommentLink(a) && !inBody(a) && (!fiber.fiberCommentId || ownIdOf(a) === fiber.fiberCommentId),
      ) || null;

    // Author: a link with text before the timestamp link and outside the body, that is a profile
    // link or carries the name from the aria-label. When the name is not a link (some anonymous
    // participants), nothing qualifies and normalize falls back to the aria-label: a later link
    // (mention, URL, hashtag) is never the author.
    const ariaName = nameFromAria(article.getAttribute('aria-label'));
    let authorA = null;
    let authorName = null;
    for (const a of links) {
      if (isCommentLink(a) || inBody(a) || (permA && !precedes(a, permA))) continue;
      const t = textOf(a);
      if (t && (isProfileHref(hrefOf(a)) || (ariaName && collapse(t) === ariaName))) {
        authorA = a;
        authorName = t;
        break;
      }
    }

    // Timestamp link without a permalink (href not filled in): a short link after the author that
    // carries an aria-label (the absolute date) — used for the date only.
    let timeA = permA;
    if (!timeA) {
      timeA =
        links.find((a) => {
          if (a === authorA || inBody(a) || !a.hasAttribute('aria-label')) return false;
          if (authorA && !precedes(authorA, a)) return false;
          const t = collapse(textOf(a));
          return t.length > 0 && t.length <= 16 && (!authorName || t !== collapse(authorName));
        }) || null;
    }

    const reactionEl =
      owned(article, '[aria-label]').find((el) => /\breactions?\b/i.test(el.getAttribute('aria-label') || '')) ||
      null;
    const truncated = owned(article, '[role="button"]').some((b) => /^see more$/i.test(collapse(b.textContent)));

    /** @type {RawAttachment[]} */
    const attachments = [];
    const seen = new Set();
    const authorPath = authorA ? stripQuery(hrefOf(authorA)) : null;
    for (const img of owned(article, 'img')) {
      if (img.closest('[role="button"]')) continue; // reaction icons
      const link = img.closest('a');
      if (
        link &&
        (link === authorA || isProfileHref(hrefOf(link)) || (authorPath && stripQuery(hrefOf(link)) === authorPath))
      ) {
        continue; // avatar / author name
      }
      const width = img.width || img.naturalWidth || 0;
      if (!(width > 32)) continue; // emoji are 16×16
      const src = img.currentSrc || img.src || '';
      if (!src || seen.has('img:' + src)) continue;
      seen.add('img:' + src);
      attachments.push({ type: 'image', src, alt: img.getAttribute('alt') || '' });
    }
    for (const video of owned(article, 'video')) {
      const link = video.closest('a');
      attachments.push({ type: 'video', href: (link && hrefOf(link)) || null });
    }
    for (const a of links) {
      if (inBody(a)) continue;
      let url;
      try {
        url = new URL(hrefOf(a));
      } catch (e) {
        continue;
      }
      if (url.hostname !== 'l.facebook.com') continue;
      const target = url.searchParams.get('u') || url.href;
      if (seen.has('link:' + target)) continue;
      seen.add('link:' + target);
      attachments.push({ type: 'link', href: target });
    }

    return {
      index,
      ariaLabel: article.getAttribute('aria-label') || '',
      authorName,
      authorHref: authorA ? hrefOf(authorA) || null : null,
      permalinkHref: permA ? hrefOf(permA) : null,
      timeAria: timeA ? timeA.getAttribute('aria-label') : null,
      timeText: timeA ? collapse(textOf(timeA)) || null : null,
      text,
      left: Math.round(article.getBoundingClientRect().left),
      reactionLabel: reactionEl ? reactionEl.getAttribute('aria-label') : null,
      truncated,
      attachments,
      ...fiber,
    };
  }

  /** @returns {RawPost} */
  function extractPost(post, kind, scopeEl, stopEl) {
    const story =
      ['[data-ad-rendering-role="story_message"]', '[data-ad-preview="message"]', '[data-ad-comet-preview="message"]']
        .map((sel) => owned(post, sel)[0])
        .find(Boolean) || null;
    const inMessage = (el) => {
      const m = el.closest(MESSAGE_SEL);
      return !!m && post.contains(m);
    };
    // Links outside the body (pasted URLs and mentions in the text are never the post's own links).
    const links = owned(post, 'a').filter((a) => !inMessage(a));

    // Post permalink. Inside an open post (dialog/main) the post has no link of its own, so a
    // /posts/ link there belongs to something else (a shared post, a link card) unless it names
    // the post in the URL. In the feed it is the header's timestamp link, which comes before the
    // body; links after the body belong to attachments such as a shared post.
    const postLinks = links.filter((a) => POST_LINK_RE.test(hrefOf(a)) && !/[?&](reply_)?comment_id=/.test(hrefOf(a)));
    const urlMatch = location.pathname.match(POST_ID_RE);
    let permA = null;
    if ((kind === 'dialog' || kind === 'main') && urlMatch) {
      permA = postLinks.find((a) => (hrefOf(a).match(POST_ID_RE) || [])[1] === urlMatch[1]) || null;
    } else {
      const header = story ? postLinks.filter((a) => precedes(a, story)) : postLinks;
      permA =
        header.find((a) => {
          const t = collapse(textOf(a));
          return DATE_RES.some((re) => re.test(t));
        }) ||
        header[0] ||
        null;
    }

    let authorA = null;
    let authorName = null;
    for (const a of links) {
      if (!isProfileHref(hrefOf(a))) continue;
      const t = textOf(a);
      if (t) {
        authorA = a;
        authorName = t;
        break;
      }
    }

    let dateText = null;
    if (kind === 'feed' && permA) dateText = collapse(textOf(permA)) || null;
    if (!dateText) {
      for (const el of owned(post, 'a, span')) {
        if (inMessage(el)) continue;
        const t = collapse(el.textContent);
        if (t && t.length <= 60 && DATE_RES.some((re) => re.test(t))) {
          dateText = t;
          break;
        }
      }
    }
    if (!dateText && permA) dateText = collapse(textOf(permA)) || null;

    let commentCountText = null;
    for (const b of owned(post, '[role="button"][aria-label="Leave a comment"]')) {
      const t = collapse(b.innerText || b.textContent);
      if (/\d/.test(t)) {
        commentCountText = t;
        break;
      }
    }

    // Comment articles are flat (replies are not nested in their parent's article); each belongs
    // to the nearest article around it that is not a comment — the post, with or without an
    // aria-label (a role-less feed post owns those not inside an article of its own). An
    // aria-labelled article with post sub-parts is a post (e.g. a shared one), never a comment.
    const items = Array.from(post.querySelectorAll(COMMENT_SEL))
      .filter((c) => {
        if (ownsPostParts(c)) return false;
        const host = owningArticle(c, post);
        return host === post || ((!host || !post.contains(host)) && post.getAttribute('role') !== 'article');
      })
      .map((c, i) => extractComment(c, i));

    // React data: the post's feed story id (walking up from the post, then its header links, then
    // the dialog/main root).
    let fiberPost = null;
    const headerLinks = story ? links.filter((a) => precedes(a, story)) : links;
    const starts = [post].concat(headerLinks.slice(0, 6));
    if (kind !== 'feed' && scopeEl && scopeEl !== post) starts.push(scopeEl);
    for (const start of starts) {
      fiberPost = fiberPostId(start, stopEl || null);
      if (fiberPost) break;
    }

    return {
      permalinkHref: permA ? hrefOf(permA) : null,
      authorName,
      authorHref: authorA ? hrefOf(authorA) || null : null,
      text: story ? textOf(story) : '',
      dateText,
      dateAria: permA ? permA.getAttribute('aria-label') : null,
      commentCountText,
      emptyState: hasEmptyStateText(scopeEl, post),
      fiberPostId: fiberPost,
      items,
    };
  }

  let rootKind = 'none';
  /** @type {RawPost[]} */
  let posts = [];
  if (scope === 'feed') {
    if (findFeed()) {
      rootKind = 'feed';
      posts = feedPosts().map(({ post, feed }) => extractPost(post, 'feed', post, feed));
    }
  } else {
    const root = findRoot();
    rootKind = root.kind;
    if (root.kind === 'dialog' || root.kind === 'main') {
      const post = topLevelPosts(root.el)[0];
      if (post) posts = [extractPost(post, root.kind, root.el)];
    } else if (root.kind === 'feed') {
      posts = feedPosts().map(({ post, feed }) => extractPost(post, 'feed', post, feed));
    }
  }

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    rootKind: /** @type {RawExtraction['rootKind']} */ (rootKind),
    extractedAt: Date.now(),
    posts,
  };
}
