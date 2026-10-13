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

  const POST_SEL = '[role="article"]:not([aria-label])';
  const COMMENT_SEL = '[role="article"][aria-label]';
  const POST_LINK_RE = /\/groups\/[^/]+\/(posts|permalink)\/[\w.-]+/;
  const POST_ID_RE = /\/groups\/[^/]+\/(?:posts|permalink)\/([\w.-]+)/;
  // The post body. Links in it (pasted URLs, mentions) are never the post's own links.
  const MESSAGE_SEL =
    '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
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

  /** a.href as a string (SVG <a> elements expose an SVGAnimatedString). */
  function hrefOf(a) {
    if (!a) return '';
    const h = a.href;
    if (typeof h === 'string') return h;
    return (h && h.baseVal) || a.getAttribute('href') || '';
  }

  /** The element belongs to `article` itself, not to an article nested inside it. */
  function ownedBy(el, article) {
    return el.closest('[role="article"]') === article;
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

  /** Post articles with no ancestor article inside `container`. */
  function topLevelPosts(container) {
    return Array.from(container.querySelectorAll(POST_SEL)).filter((p) => {
      const ancestor = p.parentElement && p.parentElement.closest('[role="article"]');
      return !ancestor || !container.contains(ancestor);
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

    const permA = links.find(isCommentLink) || null;

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
      timeAria: permA ? permA.getAttribute('aria-label') : null,
      timeText: permA ? collapse(textOf(permA)) || null : null,
      text,
      left: Math.round(article.getBoundingClientRect().left),
      reactionLabel: reactionEl ? reactionEl.getAttribute('aria-label') : null,
      truncated,
      attachments,
    };
  }

  /** @returns {RawPost} */
  function extractPost(post, kind, scopeEl) {
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
    // to its closest enclosing post article.
    const items = Array.from(post.querySelectorAll(COMMENT_SEL))
      .filter((c) => (c.parentElement && c.parentElement.closest(POST_SEL)) === post)
      .map((c, i) => extractComment(c, i));

    return {
      permalinkHref: permA ? hrefOf(permA) : null,
      authorName,
      authorHref: authorA ? hrefOf(authorA) || null : null,
      text: story ? textOf(story) : '',
      dateText,
      dateAria: permA ? permA.getAttribute('aria-label') : null,
      commentCountText,
      emptyState: hasEmptyStateText(scopeEl, post),
      items,
    };
  }

  let rootKind = 'none';
  /** @type {RawPost[]} */
  let posts = [];
  if (scope === 'feed') {
    const feed = findFeed();
    if (feed) {
      rootKind = 'feed';
      posts = topLevelPosts(feed)
        .filter(hasContent)
        .map((p) => extractPost(p, 'feed', p));
    }
  } else {
    const root = findRoot();
    rootKind = root.kind;
    if (root.kind === 'dialog' || root.kind === 'main') {
      const post = topLevelPosts(root.el)[0];
      if (post) posts = [extractPost(post, root.kind, root.el)];
    } else if (root.kind === 'feed') {
      posts = topLevelPosts(root.el)
        .filter(hasContent)
        .map((p) => extractPost(p, 'feed', p));
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
