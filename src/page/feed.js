// Page script: collect post permalinks from the rendered part of a group feed (SPEC §4.2).
//
// HARD RULE: `collectFeedPosts` is serialized with fn.toString() for page.evaluate() and
// chrome.scripting.executeScript(), so it must stay fully self-contained. Every helper is declared
// inside the function body, and nothing from module scope is referenced.

/**
 * @typedef {object} FeedPost
 * @property {string} permalinkHref    absolute href of the post's own /posts/<id>/ (or /permalink/) link
 * @property {string} postId
 * @property {string|null} authorName
 * @property {string} textPreview      first 160 characters of the post body
 * @property {string|null} dateText    the permalink link's text ("5h", "1d", …)
 * @property {string|null} commentCountText
 *
 * @typedef {object} FeedScan
 * @property {FeedPost[]} posts
 * @property {{hoverId: string}[]} missing  rendered posts without a permalink yet; hover
 *                                          `[data-fbcs-hover="<hoverId>"]` to make Facebook fill in the href
 * @property {boolean} feedFound
 * @property {number} renderedCount         top-level feed posts that currently have content
 */

/**
 * Scan the currently rendered (non-virtualized) top-level posts of the group feed.
 * The feed is virtualized, so callers must call this repeatedly while scrolling.
 * Its only DOM mutation is setting `data-fbcs-hover` on the hover target of posts without a permalink.
 *
 * @param {{markHoverFrom?: number}} [opts]
 * @returns {FeedScan}
 */
export function collectFeedPosts(opts) {
  const markHoverFrom = Math.max(0, Math.floor(Number(opts && opts.markHoverFrom) || 0));

  const POST_SEL = '[role="article"]:not([aria-label])';
  const POST_ID_RE = /\/groups\/[^/]+\/(?:posts|permalink)\/([\w.-]+)/;
  const RESERVED_SEGMENT_RE =
    /^(groups|profile\.php|photo|photo\.php|photos|watch|events|hashtag|l\.php|story\.php|permalink\.php|pages|people|reel|reels|share|stories|marketplace|gaming|notifications|messages|friends|bookmarks|search|login|help|privacy|policies)$/i;
  const TIME_RE = /^\d+\s?[smhdwy]$/;
  // Month names, so that an author called e.g. "Phyo 7" is not taken for a date ("October 7").
  const MONTH = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)';
  const DATE_RE = new RegExp(
    '^(\\d{1,2} ' + MONTH + '( \\d{4})?|' + MONTH + ' \\d{1,2}(, \\d{4})?|yesterday|today)( at \\d{1,2}:\\d{2}( ?[ap]m)?)?$' +
      '|^(just now|\\d+ \\w+ ago|an? \\w+ ago)$',
    'i',
  );
  const MESSAGE_SEL =
    '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-ad-comet-preview="message"]';

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function hrefOf(a) {
    if (!a) return '';
    const h = a.href;
    if (typeof h === 'string') return h;
    return (h && h.baseVal) || a.getAttribute('href') || '';
  }

  function owned(article, selector) {
    return Array.from(article.querySelectorAll(selector)).filter((el) => el.closest('[role="article"]') === article);
  }

  /** Node-walking text extraction (same rules as extractRaw's textOf). */
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

  function isProfileHref(href) {
    if (!href) return false;
    if (/\/user\/\d+|profile\.php\?id=/.test(href)) return true;
    const m = href.match(/^https?:\/\/([^/]+)\/([\w.]+)\/?(\?|#|$)/);
    return !!m && /(^|\.)facebook\.com$/i.test(m[1]) && !RESERVED_SEGMENT_RE.test(m[2]);
  }

  function topLevelPosts(container) {
    return Array.from(container.querySelectorAll(POST_SEL)).filter((p) => {
      const ancestor = p.parentElement && p.parentElement.closest('[role="article"]');
      return !ancestor || !container.contains(ancestor);
    });
  }

  function hasContent(post) {
    return /\S/.test(post.textContent || '') || !!post.querySelector('a[href]');
  }

  /** Header link to hover so Facebook populates the lazy permalink href. */
  function hoverTarget(links) {
    const timeLink = links.find((a) => {
      const t = collapse(textOf(a));
      return TIME_RE.test(t) || DATE_RE.test(t);
    });
    if (timeLink) return timeLink;
    const labelled = links.filter((a) => a.hasAttribute('aria-label') || a.hasAttribute('aria-labelledby'));
    return labelled.find((a) => !isProfileHref(hrefOf(a))) || labelled[0] || null;
  }

  const feeds = Array.from(document.querySelectorAll('[role="feed"]'));
  const feed = feeds.find((f) => !f.closest('[role="dialog"]')) || feeds[0] || null;
  if (!feed) return { posts: [], missing: [], feedFound: false, renderedCount: 0 };

  const rendered = topLevelPosts(feed).filter(hasContent);
  /** @type {FeedPost[]} */
  const posts = [];
  /** @type {{hoverId: string}[]} */
  const missing = [];

  for (const post of rendered) {
    const story =
      ['[data-ad-rendering-role="story_message"]', '[data-ad-preview="message"]', '[data-ad-comet-preview="message"]']
        .map((sel) => owned(post, sel)[0])
        .find(Boolean) || null;
    // The permalink is the header's timestamp link: outside the body (pasted links and mentions)
    // and before it (links after the body belong to attachments such as a shared post).
    const links = owned(post, 'a').filter((a) => {
      const m = a.closest(MESSAGE_SEL);
      return !(m && post.contains(m));
    });
    const header = story
      ? links.filter((a) => !!(story.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING))
      : links;
    const postLinks = header.filter((a) => POST_ID_RE.test(hrefOf(a)) && !/[?&](reply_)?comment_id=/.test(hrefOf(a)));
    const permA =
      postLinks.find((a) => {
        const t = collapse(textOf(a));
        return TIME_RE.test(t) || DATE_RE.test(t);
      }) ||
      postLinks[0] ||
      null;

    if (!permA) {
      const target = hoverTarget(header);
      if (target) {
        const hoverId = String(markHoverFrom + missing.length);
        target.setAttribute('data-fbcs-hover', hoverId);
        missing.push({ hoverId });
      }
      continue;
    }

    let authorName = null;
    for (const a of links) {
      if (!isProfileHref(hrefOf(a))) continue;
      const t = textOf(a);
      if (t) {
        authorName = t;
        break;
      }
    }

    let commentCountText = null;
    for (const b of owned(post, '[role="button"][aria-label="Leave a comment"]')) {
      const t = collapse(b.innerText || b.textContent);
      if (/\d/.test(t)) {
        commentCountText = t;
        break;
      }
    }

    const href = hrefOf(permA);
    posts.push({
      permalinkHref: href,
      postId: href.match(POST_ID_RE)[1],
      authorName,
      // Array.from keeps emoji surrogate pairs intact when cutting.
      textPreview: Array.from(story ? textOf(story) : '')
        .slice(0, 160)
        .join(''),
      dateText: collapse(textOf(permA)) || null,
      commentCountText,
    });
  }

  return { posts, missing, feedFound: true, renderedCount: rendered.length };
}
