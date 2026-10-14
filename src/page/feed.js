// Page script: collect post ids/permalinks from the rendered part of a group feed (SPEC §4.2).
//
// HARD RULE: `collectFeedPosts` is serialized with fn.toString() for page.evaluate() and
// chrome.scripting.executeScript(), so it must stay fully self-contained. Every helper is declared
// inside the function body, and nothing from module scope is referenced.
//
// Facebook serves different markup to different accounts (A/B experiments), so the post id has
// several sources, tried in order (SPEC §4.2): the header permalink, React's own data for the post
// (fiber props, only visible from the page's MAIN world), any other post-owned link to the post,
// and the post id its preview comments link to. Nothing here depends on the UI language.

/**
 * @typedef {object} FeedPost
 * @property {string|null} permalinkHref absolute href of the post's own /posts/<id>/ (or /permalink/)
 *                                       header link; null when the id came from another source
 * @property {string} postId
 * @property {'link'|'hover'|'react'|'link-any'|'comments'} idSource  'hover': a header link
 *                                       the driver hovered earlier carries data-fbcs-post-id
 * @property {string|null} authorName
 * @property {string} textPreview      first 160 characters of the post body
 * @property {string|null} dateText    the header time link's text ("5h", "1d", …)
 * @property {string|null} commentCountText
 *
 * @typedef {object} FeedDiag  privacy-safe (no names, text, ids or full URLs)
 * @property {number} feeds
 * @property {number} rendered
 * @property {'article'|'children'} containerMode
 * @property {{link: number, hover: number, react: number, linkAny: number, comments: number}} idSources
 * @property {number} missing
 * @property {number} hoverCandidates
 * @property {object[]} sampleShapes   masked header-link shapes of up to 3 posts without an id
 *
 * @typedef {object} FeedScan
 * @property {FeedPost[]} posts
 * @property {{hoverId: string}[]} missing  rendered posts without an id that were not hovered yet
 *                                          (no header link carries data-fbcs-hover-tried); hover
 *                                          `[data-fbcs-hover="<hoverId>"]` to make Facebook fill in the href
 * @property {boolean} feedFound
 * @property {number} renderedCount         feed posts that currently have content
 * @property {string|null} groupSlug        from location.pathname (/groups/<slug>)
 * @property {FeedDiag} diag
 */

/**
 * Scan the currently rendered (non-virtualized) posts of the group feed(s).
 * The feed is virtualized, so callers must call this repeatedly while scrolling.
 * Its only DOM mutation is setting `data-fbcs-hover` on the hover target of posts without an id.
 * Never throws on unexpected markup.
 *
 * @param {{markHoverFrom?: number}} [opts]
 * @returns {FeedScan}
 */
export function collectFeedPosts(opts) {
  const markHoverFrom = Math.max(0, Math.floor(Number(opts && opts.markHoverFrom) || 0));

  const POST_ID_RE = /\/groups\/[^/]+\/(?:posts|permalink)\/([\w.-]+)/;
  const COMMENT_LINK_RE = /[?&](reply_)?comment_id=/;
  // Other links that name the post: photo sets of the post, multi_permalinks, story_fbid.
  const ANY_POST_RES = [
    POST_ID_RE,
    /[?&]multi_permalinks=(\d+)/,
    /[?&]story_fbid=(\d+)/,
    /[?&]set=(?:pcb|gm)\.(\d+)/,
  ];
  // After the body only the post's own photo sets count (a shared post's /posts/ link does not).
  const AFTER_BODY_RES = [/[?&]set=(?:pcb|gm)\.(\d+)/];
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
  const FIBER_MAX_DEPTH = 80;
  const COMMENT_FIBER_DEPTH = 6;

  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** a.href as a string; '' for a lazy link (a.href would resolve "#" to the page URL). */
  function hrefOf(a) {
    if (!a || lazyHref(a)) return '';
    const h = a.href;
    if (typeof h === 'string') return h;
    return (h && h.baseVal) || a.getAttribute('href') || '';
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

  /** The group's own page (/groups/<slug>/), e.g. the group name in a header. */
  function isGroupRootHref(href) {
    return /^https?:\/\/[^/]+\/groups\/[^/]+\/?(\?|#|$)/.test(href || '');
  }

  function precedes(a, b) {
    return !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  function hasContent(el) {
    return /\S/.test(el.textContent || '') || !!el.querySelector('a[href]');
  }

  /** A link whose href Facebook has not filled in yet ("#…", empty, javascript:). */
  function lazyHref(a) {
    const raw = (a.getAttribute('href') || a.getAttribute('xlink:href') || '').trim();
    return raw === '' || raw.charAt(0) === '#' || /^javascript:/i.test(raw);
  }

  // ---- React fiber data (visible only from the page's MAIN world) -----------------------------

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

  /** Post id from a feed story's id: base64 of "S:_I<digits>:VK:<postId>" (live-verified). */
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

  function propsPostId(props) {
    if (!props || typeof props !== 'object') return null;
    let keys;
    try {
      keys = Object.keys(props);
    } catch (e) {
      return null;
    }
    keys.sort((a, b) => (b === 'feedUnit') - (a === 'feedUnit'));
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
    return null;
  }

  /** Walks up the fiber tree from `el` (≤ 80 levels, never past `stopEl`'s own fiber). */
  function fiberPostId(el, stopEl) {
    let f = fiberOf(el);
    for (let i = 0; f && i < FIBER_MAX_DEPTH; i++) {
      try {
        if (stopEl && f.stateNode === stopEl) return null;
        const id = propsPostId(f.memoizedProps);
        if (id) return id;
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
    for (let i = 0; f && i < COMMENT_FIBER_DEPTH; i++) {
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

  /** Post id from a comment's fiber id: base64 of "comment:<postId>_<commentId>". */
  function commentFiberPostId(comment) {
    try {
      const m = /^comment:(\d+)_\d+/.exec(b64(String(comment && comment.id)) || '');
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  // ---- Containers & ownership -----------------------------------------------------------------

  const commentLikeCache = new Map();
  /**
   * A comment article (feed preview): its own links carry comment_id, or its fiber has a
   * `comment` prop. Post sub-parts (body, like/comment buttons) mean it is a post.
   */
  function isCommentLike(article) {
    if (commentLikeCache.has(article)) return commentLikeCache.get(article);
    let result = false;
    try {
      const own = (el) => el.closest('[role="article"]') === article;
      const postParts = Array.from(article.querySelectorAll(MESSAGE_SEL + ', [data-ad-rendering-role]')).some(own);
      if (!postParts) {
        result =
          Array.from(article.querySelectorAll('a')).some((a) => own(a) && COMMENT_LINK_RE.test(hrefOf(a))) ||
          !!fiberComment(article);
      }
    } catch (e) {
      result = false;
    }
    commentLikeCache.set(article, result);
    return result;
  }

  /**
   * `el` belongs to `container` itself: for an article container, its closest article is the
   * container; for a role-less container, it is not inside a comment article of it.
   */
  function ownedBy(el, container) {
    const a = el.closest('[role="article"]');
    if (a === container) return true;
    if (container.getAttribute('role') === 'article') return false;
    return !a || !container.contains(a) || !isCommentLike(a);
  }

  function owned(container, selector) {
    return Array.from(container.querySelectorAll(selector)).filter((el) => ownedBy(el, container));
  }

  /** Top-level non-comment articles of a feed; else (role-less posts) its children with content. */
  function containersOf(feed) {
    const articles = Array.from(feed.querySelectorAll('[role="article"]')).filter((a) => {
      const ancestor = a.parentElement && a.parentElement.closest('[role="article"]');
      return !(ancestor && feed.contains(ancestor)) && !isCommentLike(a);
    });
    if (articles.length || !hasContent(feed)) return { mode: 'article', list: articles };
    let parent = feed;
    // A single wrapper around every post: look inside it.
    for (let i = 0; i < 4; i++) {
      const kids = Array.from(parent.children).filter(hasContent);
      if (kids.length === 1 && kids[0].children.length > 1 && kids[0].getAttribute('role') !== 'article') {
        parent = kids[0];
      } else break;
    }
    return { mode: 'children', list: Array.from(parent.children) };
  }

  // ---- Privacy-safe shapes for diagnostics ---------------------------------------------------

  const SAFE_SEGMENT_RE =
    /^(groups|user|posts|permalink|photo|photos|photo\.php|profile\.php|story\.php|permalink\.php|l\.php|hashtag|watch|events|reel|reels|share|pages|people|media|set|videos|stories|commerce|buy_sell_discussion|discussion)$/i;

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

  function hrefShape(a) {
    const raw = a.getAttribute('href');
    if (raw == null) return 'none';
    const t = raw.trim();
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
    const keys = [];
    u.searchParams.forEach((v, k) => {
      if (/^__/.test(k)) return;
      const key = /^[a-z_]{1,30}$/i.test(k) ? k : '{k}';
      if (keys.indexOf(key) === -1) keys.push(key);
    });
    return host + pathShape(u.pathname) + (keys.length ? '?' + keys.join('&') : '') + (u.hash && u.hash !== '#' ? '#…' : '');
  }

  function linkShape(a, where) {
    return {
      where,
      href: hrefShape(a),
      text: textShape(textOf(a)),
      ariaLabel: a.hasAttribute('aria-label'),
      labelledby: a.hasAttribute('aria-labelledby'),
      tabindex: /^-?\d$/.test(a.getAttribute('tabindex') || '') ? a.getAttribute('tabindex') : null,
    };
  }

  // ---- Scan -----------------------------------------------------------------------------------

  const pathMatch = /^\/groups\/([^/]+)/.exec(location.pathname || '');
  let groupSlug = null;
  if (pathMatch) {
    try {
      groupSlug = decodeURIComponent(pathMatch[1]);
    } catch (e) {
      groupSlug = pathMatch[1];
    }
  }

  const allFeeds = Array.from(document.querySelectorAll('[role="feed"]'));
  let feeds = allFeeds.filter((f) => !f.closest('[role="dialog"]'));
  if (!feeds.length) feeds = allFeeds;
  feeds = feeds.filter((f) => !feeds.some((other) => other !== f && other.contains(f)));

  /** @type {FeedDiag} */
  const diag = {
    feeds: feeds.length,
    rendered: 0,
    containerMode: 'article',
    idSources: { link: 0, hover: 0, react: 0, linkAny: 0, comments: 0 },
    missing: 0,
    hoverCandidates: 0,
    sampleShapes: [],
  };
  if (!feeds.length) return { posts: [], missing: [], feedFound: false, renderedCount: 0, groupSlug, diag };

  /** @type {FeedPost[]} */
  const posts = [];
  /** @type {{hoverId: string}[]} */
  const missing = [];
  const seen = new Set();

  for (const feed of feeds) {
    let found;
    try {
      found = containersOf(feed);
    } catch (e) {
      continue;
    }
    if (found.mode === 'children') diag.containerMode = 'children';
    const rendered = found.list.filter(hasContent);
    diag.rendered += rendered.length;

    for (const post of rendered) {
      try {
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
        const header = story ? links.filter((a) => precedes(a, story)) : links;
        const afterBody = story ? links.filter((a) => !precedes(a, story)) : [];
        const isTimeText = (a) => {
          const t = collapse(textOf(a));
          return TIME_RE.test(t) || DATE_RE.test(t);
        };

        // 1. Header permalink.
        const postLinks = header.filter(
          (a) => !lazyHref(a) && POST_ID_RE.test(hrefOf(a)) && !COMMENT_LINK_RE.test(hrefOf(a)),
        );
        const permA = postLinks.find(isTimeText) || postLinks[0] || null;
        let postId = permA ? hrefOf(permA).match(POST_ID_RE)[1] : null;
        let idSource = postId ? 'link' : null;

        // 1b. A header link the driver hovered earlier (it noted the id it showed; the href itself
        //     can be cleared again when the pointer leaves).
        if (!postId) {
          const marked = header.find((a) => /^[\w.-]+$/.test(a.getAttribute('data-fbcs-post-id') || ''));
          if (marked) {
            postId = marked.getAttribute('data-fbcs-post-id');
            idSource = 'hover';
          }
        }

        // 2. React data of the post (feedUnit id), walking up from the post and its header links.
        if (!postId) {
          for (const start of [post].concat(header.slice(0, 6))) {
            postId = fiberPostId(start, feed);
            if (postId) break;
          }
          if (postId) idSource = 'react';
        }

        // 3. Any other post-owned link naming the post (all such links must agree).
        if (!postId) {
          const ids = new Set();
          const consider = (a, res) => {
            const h = hrefOf(a);
            if (lazyHref(a) || COMMENT_LINK_RE.test(h)) return;
            for (const re of res) {
              const m = re.exec(h);
              if (m) {
                ids.add(m[1]);
                return;
              }
            }
          };
          header.forEach((a) => consider(a, ANY_POST_RES));
          afterBody.forEach((a) => consider(a, AFTER_BODY_RES));
          if (ids.size === 1) {
            postId = Array.from(ids)[0];
            idSource = 'link-any';
          }
        }

        // 4. The post id its preview comments point at (majority), one vote per comment: its React
        //    data, else its first comment link (the timestamp, which comes before its text) — a
        //    link to another post pasted in a comment's text cannot outvote the others.
        if (!postId) {
          const votes = new Map();
          const vote = (id) => {
            if (id) votes.set(id, (votes.get(id) || 0) + 1);
          };
          const voted = new Set();
          for (const art of Array.from(post.querySelectorAll('[role="article"]'))) {
            const id = commentFiberPostId(fiberComment(art));
            if (id) {
              vote(id);
              voted.add(art);
            }
          }
          for (const a of Array.from(post.querySelectorAll('a'))) {
            const h = hrefOf(a);
            if (!COMMENT_LINK_RE.test(h)) continue;
            const m = a.closest(MESSAGE_SEL);
            if (m && post.contains(m)) continue;
            const art = a.closest('[role="article"]');
            const voter = art && art !== post && post.contains(art) ? art : a;
            if (voted.has(voter)) continue;
            voted.add(voter);
            const pm = POST_ID_RE.exec(h);
            if (pm) vote(pm[1]);
          }
          let best = 0;
          votes.forEach((n, id) => {
            if (n > best) {
              best = n;
              postId = id;
            }
          });
          if (postId) idSource = 'comments';
        }

        if (!postId) {
          diag.missing++;
          if (diag.sampleShapes.length < 3) {
            diag.sampleShapes.push({
              role: post.getAttribute('role') === 'article' ? 'article' : null,
              ariaLabel: post.hasAttribute('aria-label'),
              labelledby: post.hasAttribute('aria-labelledby'),
              posinset: post.hasAttribute('aria-posinset'),
              story: !!story,
              fiber: !!fiberOf(post),
              links: links.length,
              header: header.slice(0, 8).map((a) => linkShape(a, 'header')),
            });
          }
          // Hover target so Facebook fills in a lazy href: a header link that is not a profile or
          // group link; prefer aria-labelledby (the live permalink has it), then a lazy href, then
          // short text. Language-independent. Each post is hovered at most once: the driver marks
          // the link it hovered (data-fbcs-hover-tried), because hovering scrolls back to the post
          // and a post that never yields an id would otherwise pin the feed scroll every round.
          if (header.some((a) => a.hasAttribute('data-fbcs-hover-tried'))) continue;
          let target = null;
          let bestScore = -1;
          for (const a of header) {
            const h = hrefOf(a);
            if (!lazyHref(a) && (isProfileHref(h) || isGroupRootHref(h))) continue;
            const len = Array.from(collapse(textOf(a))).length;
            const score =
              (a.hasAttribute('aria-labelledby') ? 4 : 0) + (lazyHref(a) ? 2 : 0) + (len > 0 && len <= 24 ? 1 : 0);
            if (score > bestScore) {
              bestScore = score;
              target = a;
            }
          }
          if (target) {
            const hoverId = String(markHoverFrom + missing.length);
            target.setAttribute('data-fbcs-hover', hoverId);
            missing.push({ hoverId });
            diag.hoverCandidates++;
          }
          continue;
        }
        if (seen.has(postId)) continue;
        seen.add(postId);
        diag.idSources[idSource === 'link-any' ? 'linkAny' : idSource]++;

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

        const timeA = permA || header.find(isTimeText) || null;
        posts.push({
          permalinkHref: permA ? hrefOf(permA) : null,
          postId,
          idSource: /** @type {FeedPost['idSource']} */ (idSource),
          authorName,
          // Array.from keeps emoji surrogate pairs intact when cutting.
          textPreview: Array.from(story ? textOf(story) : '')
            .slice(0, 160)
            .join(''),
          dateText: timeA ? collapse(textOf(timeA)) || null : null,
          commentCountText,
        });
      } catch (e) {
        // Unexpected markup in one post never stops the scan.
      }
    }
  }

  return { posts, missing, feedFound: true, renderedCount: diag.rendered, groupSlug, diag };
}
