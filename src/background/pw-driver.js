// All Playwright usage lives here (SPEC.md §7). Playwright runs inside the extension via
// playwright-crx, which drives the user's own tab over chrome.debugger.
//
// Page functions from ../page/*.js are passed straight to page.evaluate(fn, arg); they are
// serialized with fn.toString(), so they (and the small inline page functions below) must never
// reference anything outside their own body.

import { crx } from 'playwright-crx';
import { collectFeedPosts } from '../page/feed.js';
import { probePage } from '../page/probe.js';
import { canonicalPostUrl, parseFbUrl } from '../lib/fb-url.js';
import { parseCount } from '../lib/normalize.js';
import { DEFAULT_SETTINGS } from '../lib/constants.js';

/** @typedef {import('../lib/constants.js').Settings} Settings */
/** @typedef {{expander: RegExp, seeMore: RegExp, sortButton: RegExp, sortAllItem: RegExp}} Patterns */
/**
 * @typedef {object} DriverCtx
 * @property {Settings} settings
 * @property {Patterns} patterns          compilePatterns(settings)
 * @property {AbortSignal} signal
 * @property {(level: 'info'|'warn'|'error', msg: string) => void} log
 * @property {(partialState: object) => void} progress
 */
/** @typedef {any} Page  Playwright Page (playwright-crx or Node playwright — same API) */
/** @typedef {any} Locator */

/** Post sub-parts (body, profile_name, like/comment/share buttons): a comment never has one. */
const POST_PARTS_SEL = '[data-ad-rendering-role], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
/** Comment/reply articles: aria-labelled, without post sub-parts (some accounts' posts have an aria-label too). */
const COMMENT_SEL = `[role="article"][aria-label]:not(:has(${POST_PARTS_SEL}))`;
/** Holds a post article (SPEC §4): one without aria-label, or one with post sub-parts. */
const HAS_POST_ARTICLE = `:has([role="article"]:not([aria-label]), [role="article"] :is(${POST_PARTS_SEL}))`;
const POST_DIALOG_SEL = `[role="dialog"]${HAS_POST_ARTICLE}`;
const POST_MAIN_SEL = `[role="main"]${HAS_POST_ARTICLE}`;
/** Labels we must never click, whatever the patterns say (SPEC §10). */
const FORBIDDEN_LABEL = /^(hide|reply|like|share|follow|join|send|write|comment|leave a comment)\b/i;
/** An expander (per thread) that failed this many times in a row without loading anything is skipped. */
const STUCK_AFTER = 3;
/** Quiet rounds (no new comments, nothing loading, scrolled to the end) before a post counts as fully loaded. */
const STABLE_ROUNDS_NEEDED = 2;
/** Give up on comment "See more" buttons that stay put after this many rounds. */
const SEE_MORE_GIVE_UP_ROUNDS = 3;
/** After a click or a scroll, wait at most this long for loading indicators in the post to clear. */
const QUIET_WAIT_MS = 10000;
/** A loading indicator that stays visible this long is not a load in progress; it is ignored. */
const SPINNER_IGNORE_MS = 15000;
/** Switches to "All comments" per post (the first one plus a retry if the sort is found reverted). */
const MAX_SORT_ATTEMPTS = 2;
/** A [role=main] post root is accepted only after this long without a dialog (see waitForPostRoot). */
const MAIN_GRACE_MS = 5000;
/** Error message when the post being expanded goes away (dialog closed, tab navigated). */
export const POST_CLOSED_MSG = 'The post was closed or the tab navigated away while saving — nothing was saved for it.';

// ------------------------------------------------------------------------------------------------
// Errors, abort & pacing helpers (also used by job-runner.js)

/** Thrown when the job's AbortSignal fires; the runner turns it into status 'stopped'. */
export class AbortError extends Error {
  constructor(message = 'Stopped') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Unrecoverable condition (login wall, rate-limit block, lost debugger): a crawl must stop.
 * `code` is 'login' | 'blocked' | 'detached'.
 */
export class FatalError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'FatalError';
    this.code = code;
  }
}

/** @param {unknown} err */
export function isAbortError(err) {
  return !!err && typeof err === 'object' && /** @type {any} */ (err).name === 'AbortError';
}

/** @param {AbortSignal|undefined} signal */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Resolves after `ms`; rejects with AbortError as soon as `signal` aborts.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pacing delay: actionDelayMs + 0..50 % jitter, scaled by `factor`.
 * @param {Settings} settings
 * @param {number} [factor]
 */
export function actionDelay(settings, factor = 1) {
  const base = Number(settings?.actionDelayMs) || 700;
  return Math.round((base + Math.random() * base * 0.5) * factor);
}

/** @param {DriverCtx} ctx @param {number} [factor] */
function pause(ctx, factor = 1) {
  return sleep(actionDelay(ctx.settings, factor), ctx.signal);
}

/** True for errors meaning the page/tab/debugger connection is gone. */
export function isTargetClosedError(err) {
  const msg = String(/** @type {any} */ (err)?.message ?? err ?? '');
  return /target (page, context or browser )?(has been )?closed|target closed|browser has been closed|has been detached|debugger is not attached|no tab with (given )?id|session closed/i.test(
    msg,
  );
}

// ------------------------------------------------------------------------------------------------
// Inline page functions (self-contained; run in the page)

/** Viewport size of the page. */
function pageViewport() {
  return { w: window.innerWidth, h: window.innerHeight };
}

/**
 * Root readiness for waitForPostRoot:
 * - 'dialog' when a dialog holds a post article with content;
 * - 'main-verified' / 'main' when, on a post URL, [role=main] holds exactly one post and no feed
 *   (a /permalink/ layout) — 'main-verified' when that post links to the URL's post id;
 * - 'loading' when a post article or a post dialog exists but is still a skeleton;
 * - 'unavailable' for Facebook's "This content isn't available" page; null otherwise.
 * A [role=main] holding a feed is never a post root: a post URL loaded directly shows the home (or
 * group) feed there until the post's dialog mounts.
 */
function pagePostRootState() {
  const PARTS = '[data-ad-rendering-role], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
  // A post article: no aria-label, or an aria-label and post sub-parts (comments have neither).
  const isPost = (a) => !a.hasAttribute('aria-label') || !!a.querySelector(PARTS);
  const hasContent = (a) => (a.textContent || '').trim().length > 0 || !!a.querySelector('a[href], img');
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const topLevel = (container) =>
    Array.from(container.querySelectorAll('[role="article"]')).filter((p) => {
      const ancestor = p.parentElement && p.parentElement.closest('[role="article"]');
      return (!ancestor || !container.contains(ancestor)) && isPost(p);
    });
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
  for (let i = dialogs.length - 1; i >= 0; i--) {
    const art = Array.from(dialogs[i].querySelectorAll('[role="article"]')).find(isPost);
    if (art) return hasContent(art) ? 'dialog' : 'loading';
  }
  const m = location.pathname.match(/\/groups\/[^/]+\/(?:posts|permalink)\/([\w.-]+)/);
  if (m) {
    // A post dialog still rendering its skeleton: wait for it instead of taking the page behind it.
    const skeleton = dialogs.some((d) => {
      if (!visible(d)) return false;
      if (d.querySelector('[role="progressbar"], [data-visualcompletion="loading-state"]')) return true;
      const heading = d.querySelector('h1, h2, [role="heading"]');
      const title = (d.getAttribute('aria-label') || (heading && heading.textContent) || '').replace(/\s+/g, ' ').trim();
      return /['’]s post$/i.test(title);
    });
    if (skeleton) return 'loading';
    const main = document.querySelector('[role="main"]');
    if (main && !main.querySelector('[role="feed"]')) {
      const posts = topLevel(main);
      const filled = posts.filter(hasContent);
      if (filled.length === 1) {
        const id = m[1];
        const named = Array.from(filled[0].querySelectorAll('a[href]')).some((a) => {
          const href = a.getAttribute('href') || '';
          for (const seg of ['/posts/', '/permalink/']) {
            const at = href.indexOf(seg + id);
            if (at !== -1 && /^([/?#&]|$)/.test(href.slice(at + seg.length + id.length))) return true;
          }
          return false;
        });
        return named ? 'main-verified' : 'main';
      }
      if (posts.length && !filled.length) return 'loading';
    }
  }
  const main = document.querySelector('[role="main"]') || document.body;
  if (main && !main.querySelector('[role="article"]')) {
    const text = (main.textContent || '').slice(0, 3000);
    if (/(this )?(content|page) isn.t available|content isn.t available right now/i.test(text)) return 'unavailable';
  }
  return null;
}

/**
 * Visible loading indicators inside the post root, near the viewport (runs on the root element).
 * Loads we trigger (clicked expanders, lazy comments at the bottom) show their spinner on screen;
 * placeholders far off screen (e.g. lazy images) are not loads to wait for.
 */
function rootLoadingCount(el) {
  const h = window.innerHeight || 800;
  return Array.from(el.querySelectorAll('[role="progressbar"], [data-visualcompletion="loading-state"]')).filter((n) => {
    if (!(n.offsetWidth || n.offsetHeight || n.getClientRects().length)) return false;
    const r = n.getBoundingClientRect();
    return r.bottom > -h && r.top < 2 * h;
  }).length;
}

/** True when a group feed has rendered a post (an article, or a child with text for role-less posts). */
function pageFeedReady() {
  return Array.from(document.querySelectorAll('[role="feed"]')).some(
    (f) => !!f.querySelector('[role="article"]') || Array.from(f.children).some((c) => /\S/.test(c.textContent || '')),
  );
}

/**
 * Reads the href of a hovered header link (data-fbcs-hover) right away — Facebook can clear it
 * again when the pointer leaves — and parses the post id it names. Self-contained page function.
 */
function hoveredPostLink(hoverId) {
  const el = document.querySelector('[data-fbcs-hover="' + String(hoverId).replace(/["\\]/g, '') + '"]');
  if (!el) return null;
  // Hovered once: collectFeedPosts does not offer this post for hovering again (see markHoverTried).
  el.setAttribute('data-fbcs-hover-tried', '1');
  const raw = (el.getAttribute('href') || '').trim();
  if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
  let href;
  try {
    href = new URL(raw, location.href).href;
  } catch (e) {
    return null;
  }
  if (/[?&](reply_)?comment_id=/.test(href)) return null;
  const m = /\/groups\/([^/?#]+)\/(?:posts|permalink)\/([\w.-]+)/.exec(href);
  const q = m ? null : /[?&](?:multi_permalinks|story_fbid)=(\d+)/.exec(href);
  if (!m && !q) return null;
  const postId = m ? m[2] : q[1];
  // Remember it on the link: later scans see the id even after Facebook clears the href again.
  el.setAttribute('data-fbcs-post-id', postId);
  let slug = m ? m[1] : null;
  try {
    if (slug) slug = decodeURIComponent(slug);
  } catch (e) {
    // keep the raw segment
  }
  return { postId, groupSlug: slug, href };
}

/**
 * Marks a hover target as tried when hovering it failed (hoveredPostLink marks the ones it reads).
 * Hovering scrolls back to the post, so a post that never yields an id must be hovered only once,
 * or it pins the feed's scroll position every round. Self-contained page function.
 */
function markHoverTried(hoverId) {
  const el = document.querySelector('[data-fbcs-hover="' + String(hoverId).replace(/["\\]/g, '') + '"]');
  if (el) el.setAttribute('data-fbcs-hover-tried', '1');
}

/**
 * Element state used for click bookkeeping (runs on an element handle). `key` identifies an
 * expander per thread: its label plus the id of the comment just before it in document order
 * (labels such as "View 1 reply" repeat in many threads).
 */
function elementLabelState(el) {
  const text = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  let anchor = 'top';
  const articles = document.querySelectorAll('[role="article"][aria-label]');
  for (let i = articles.length - 1; i >= 0; i--) {
    const art = articles[i];
    if (art.contains(el) || !(art.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    anchor = `#${i}`;
    const link = art.querySelector('a[href*="comment_id="]');
    if (link) {
      try {
        const u = new URL(link.getAttribute('href') || '', location.href);
        anchor = u.searchParams.get('reply_comment_id') || u.searchParams.get('comment_id') || anchor;
      } catch (e) {
        // keep the index
      }
    }
    break;
  }
  // A post article: no aria-label, or an aria-label and post sub-parts (comments have neither).
  const PARTS = '[data-ad-rendering-role], [data-ad-preview="message"], [data-ad-comet-preview="message"]';
  const isPost = (a) => !a.hasAttribute('aria-label') || !!a.querySelector(PARTS);
  const nearest = el.closest('[role="article"]');
  let inPost = false;
  for (let a = nearest; a; a = a.parentElement && a.parentElement.closest('[role="article"]')) {
    if (isPost(a)) {
      inPost = true;
      break;
    }
  }
  return {
    connected: el.isConnected,
    text,
    key: `${text}@${anchor}`,
    inComment: !!nearest && !isPost(nearest),
    inPost,
  };
}

/** Plain DOM click — last-resort fallback (works on Facebook's controls, SPEC §1). */
function domClick(el) {
  el.click();
}

/** Moves page scroll to the top (feed collection starts from the newest posts). */
function scrollPageToTop() {
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------------------------------------
// Page lifecycle

/**
 * Attach Playwright to `tabId`, run `fn(page)`, and always release the debugger afterwards
 * (removes Chrome's "started debugging this browser" bar).
 *
 * `options.onDetach(reason)` is called if Chrome ends the debugging session on its own while `fn`
 * runs — e.g. reason 'canceled_by_user' (Cancel clicked on the infobar) or 'target_closed'.
 * @template T
 * @param {number} tabId
 * @param {(page: Page) => Promise<T>} fn
 * @param {{onDetach?: (reason: string) => void}} [options]
 * @returns {Promise<T>}
 */
export async function withPage(tabId, fn, options = {}) {
  const onDebuggerDetach = (source, reason) => {
    if (source?.tabId === tabId) options.onDetach?.(String(reason || 'unknown'));
  };
  const debuggerEvents = globalThis.chrome?.debugger?.onDetach;
  debuggerEvents?.addListener(onDebuggerDetach);

  let app = await crx.get().catch(() => undefined);
  if (!app) app = await crx.start();
  let page;
  try {
    page = await app.attach(tabId);
    return await fn(page);
  } catch (err) {
    // Any failure after the debugger went away is reported as such, not as a random Playwright error.
    if (page && !isAbortError(err) && !(err instanceof FatalError) && !(await isPageConnected(page, tabId))) {
      // Give chrome.debugger.onDetach a moment to arrive so options.onDetach learns the reason.
      await sleep(300);
      throw new FatalError(LOST_CONNECTION_MSG, 'detached');
    }
    throw err;
  } finally {
    // Our own detach must not be reported as a user cancel.
    debuggerEvents?.removeListener(onDebuggerDetach);
    if (page) await app.detach(page).catch(() => {});
    await app.close().catch(() => {});
  }
}

const LOST_CONNECTION_MSG =
  'Lost the connection to the tab: debugging was cancelled (the "Cancel" button on Chrome\'s debugging bar) or the tab was closed.';

/**
 * True while Playwright's page is open and our chrome.debugger session on the tab still answers.
 * @param {Page} page
 * @param {number} tabId
 */
export async function isPageConnected(page, tabId) {
  if (!page || page.isClosed()) return false;
  const dbg = globalThis.chrome?.debugger;
  if (!dbg) return true; // not in the extension (Node tests)
  try {
    await dbg.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true });
    return true;
  } catch {
    return false;
  }
}

/** page.evaluate with a couple of retries for "execution context was destroyed" during navigation. */
async function evaluateWithRetry(page, fn, arg, signal, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    throwIfAborted(signal);
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      if (isTargetClosedError(err)) throw err;
      lastErr = err;
      await sleep(500, signal);
    }
  }
  throw lastErr;
}

/** probePage options built from compiled (already validated) patterns. */
function probeOptions(patterns) {
  return {
    expanderPattern: patterns.expander.source,
    seeMorePattern: patterns.seeMore.source,
    sortButtonPattern: patterns.sortButton.source,
  };
}

/** Throw a FatalError if the probe shows a login wall or a rate-limit block. */
function assertNotWalled(probe) {
  if (probe?.blocked) {
    throw new FatalError(
      'Facebook says this action is temporarily blocked ("going too fast"). Stopped — wait a while and try again with a larger action delay.',
      'blocked',
    );
  }
  if (probe?.loginRequired) {
    throw new FatalError('Facebook is asking you to log in. Log in in this tab, then try again.', 'login');
  }
}

/**
 * Wait until the open post (dialog or permalink page) has rendered.
 * A feed in [role=main] is never taken for the post (a post URL loaded directly shows the home or
 * group feed until its dialog mounts). A single-post [role=main] is accepted at once when it links
 * to the URL's post id, otherwise only after it stayed dialog-free for MAIN_GRACE_MS.
 * @param {Page} page
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<'dialog'|'main'>}
 */
export async function waitForPostRoot(page, { timeoutMs = 30000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let mainSince = 0;
  let unavailableSince = 0;
  for (;;) {
    throwIfAborted(signal);
    let state = null;
    try {
      state = await page.evaluate(pagePostRootState);
    } catch (err) {
      if (isTargetClosedError(err)) throw err;
      // Navigation in progress — try again.
    }
    if (state === 'dialog') return 'dialog';
    if (state === 'main-verified') return 'main';
    if (state === 'main') {
      if (!mainSince) mainSince = Date.now();
      if (Date.now() - mainSince >= MAIN_GRACE_MS) return 'main';
    } else {
      mainSince = 0;
    }
    if (state === 'unavailable') {
      if (!unavailableSince) unavailableSince = Date.now();
      if (Date.now() - unavailableSince >= 2000) {
        throw new Error('Facebook says this content isn\'t available (deleted, or not visible to you).');
      }
    } else {
      unavailableSince = 0;
    }
    if (Date.now() > deadline) break;
    await sleep(300, signal);
  }
  // Timed out: explain why if we can.
  let probe = null;
  try {
    probe = await page.evaluate(probePage, {
      expanderPattern: DEFAULT_SETTINGS.expanderPattern,
      seeMorePattern: DEFAULT_SETTINGS.seeMorePattern,
      sortButtonPattern: DEFAULT_SETTINGS.sortButtonPattern,
    });
  } catch {
    // ignore
  }
  assertNotWalled(probe);
  throw new Error(`The post did not load within ${Math.round(timeoutMs / 1000)} s (it may have been deleted or is not visible to you).`);
}

// ------------------------------------------------------------------------------------------------
// Clicking

/**
 * Click with fallbacks: Playwright click (trusted events + actionability) → dispatchEvent('click')
 * → DOM element.click() (e.g. when Messenger's chat popup covers the button).
 * @param {Locator} target  Locator or ElementHandle
 * @returns {Promise<'click'|'dispatch'|'dom'>}
 */
export async function clickRobust(target) {
  try {
    await target.click({ timeout: 4000 });
    return 'click';
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
  }
  // (Locator methods take a timeout option; ElementHandle methods ignore the extra argument.)
  try {
    await target.dispatchEvent('click', undefined, { timeout: 4000 });
    return 'dispatch';
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
  }
  await target.evaluate(domClick, undefined, { timeout: 4000 });
  return 'dom';
}

/** Root locator for the open post. */
function rootLocator(page, rootKind) {
  return rootKind === 'dialog' ? page.locator(POST_DIALOG_SEL).last() : page.locator(POST_MAIN_SEL).first();
}

/** Number of comment/reply articles currently inside root. */
async function countComments(root) {
  try {
    return await root.locator(COMMENT_SEL).count();
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
    return 0;
  }
}

/**
 * Loading indicators ([role=progressbar], loading-state placeholders) inside the post root, tracked
 * over one post: `waitQuiet` waits (bounded) for them to clear, and an indicator that stays visible
 * for SPINNER_IGNORE_MS is ignored from then on so it cannot stall the loop.
 * @param {DriverCtx} ctx
 * @param {number} deadline  per-post time limit (epoch ms)
 */
function loadingTracker(ctx, deadline) {
  let busySince = 0;
  let ignore = false;

  /** True while something in root is still loading. */
  async function busy(root) {
    if (ignore) return false;
    let n = 0;
    try {
      n = await root.evaluate(rootLoadingCount, undefined, { timeout: 2000 });
    } catch (err) {
      if (isTargetClosedError(err)) throw err;
      return false; // root gone — the caller notices that separately
    }
    if (!n) {
      busySince = 0;
      return false;
    }
    if (!busySince) busySince = Date.now();
    if (Date.now() - busySince >= SPINNER_IGNORE_MS) {
      ignore = true;
      ctx.log('warn', `A loading indicator stayed visible for ${Math.round(SPINNER_IGNORE_MS / 1000)} s; ignoring it.`);
      return false;
    }
    return true;
  }

  /**
   * Wait until nothing in root is loading, at most `maxMs` (and never past the post's deadline).
   * @returns {Promise<boolean>} true when root is quiet
   */
  async function waitQuiet(root, maxMs = QUIET_WAIT_MS) {
    const until = Math.min(Date.now() + maxMs, deadline);
    for (;;) {
      if (!(await busy(root))) return true;
      if (Date.now() >= until) return false;
      await sleep(250, ctx.signal);
    }
  }

  return { busy, waitQuiet };
}

/** Closes an open [role=menu] with Escape (never pressed otherwise — Escape closes the post dialog). */
async function closeOpenMenus(page) {
  try {
    const menus = page.locator('[role="menu"]');
    if ((await menus.count()) > 0 && (await menus.first().isVisible())) {
      await page.keyboard.press('Escape');
    }
  } catch {
    // best effort
  }
}

/**
 * Scroll step: wheel over the root's centre (lazy loading needs real wheel events), then bring the
 * last comment into view.
 */
async function scrollRoot(page, root, ctx) {
  let vp = { w: 1200, h: 800 };
  try {
    vp = await page.evaluate(pageViewport);
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
  }
  let x = vp.w / 2;
  let y = vp.h / 2;
  try {
    // Centre of the root's visible part (a permalink page's [role=main] is taller than the viewport).
    const box = await root.boundingBox({ timeout: 2000 });
    if (box) {
      const left = Math.max(box.x, 0);
      const right = Math.min(box.x + box.width, vp.w);
      const top = Math.max(box.y, 0);
      const bottom = Math.min(box.y + box.height, vp.h);
      if (right > left && bottom > top) {
        x = (left + right) / 2;
        y = (top + bottom) / 2;
      }
    }
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
  }
  x = Math.min(Math.max(x, 5), Math.max(vp.w - 5, 5));
  y = Math.min(Math.max(y, 5), Math.max(vp.h - 5, 5));
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 2500);
  await sleep(150, ctx.signal);
  await page.mouse.wheel(0, 2500);
  try {
    const last = root.locator(COMMENT_SEL).last();
    if ((await root.locator(COMMENT_SEL).count()) > 0) await last.scrollIntoViewIfNeeded({ timeout: 2000 });
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
  }
}

/**
 * Click `post`-level (outside comments) or comment-level "See more" buttons inside root.
 * @returns {Promise<{clicked: number, remaining: number}>}
 */
async function clickSeeMore(root, ctx, where) {
  const handles = await root.getByRole('button', { name: ctx.patterns.seeMore }).elementHandles();
  let clicked = 0;
  let remaining = 0;
  try {
    for (const h of handles) {
      throwIfAborted(ctx.signal);
      const info = await h.evaluate(elementLabelState).catch(() => null);
      if (!info?.connected) continue;
      // Post-level = inside the post article but not in a comment; comment-level = in a comment.
      if (where === 'post' ? !info.inPost || info.inComment : !info.inComment) continue;
      remaining++;
      try {
        await clickRobust(h);
        clicked++;
      } catch (err) {
        if (isTargetClosedError(err)) throw err;
      }
      await pause(ctx, 0.4);
    }
  } finally {
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  }
  return { clicked, remaining };
}

/**
 * One pass over the expander buttons ("View 3 replies", "View more comments", …) in DOM order.
 * Handles keep a stable snapshot; buttons revealed by these clicks are handled next round.
 * After each click it waits for the post's loading indicators to clear before judging the click.
 * @param {Map<string, number>} stuck  per-thread key (label@comment id) → consecutive clicks that loaded nothing
 * @param {ReturnType<typeof loadingTracker>} loading
 */
async function clickExpanders(root, ctx, stuck, deadline, loading) {
  const { patterns, settings } = ctx;
  const handles = await root.getByRole('button', { name: patterns.expander }).elementHandles();
  const result = { clicked: 0, stuckSkipped: 0, repliesSkipped: 0, timedOut: false };
  try {
    for (const h of handles) {
      throwIfAborted(ctx.signal);
      if (Date.now() > deadline) {
        result.timedOut = true;
        break;
      }
      const info = await h.evaluate(elementLabelState).catch(() => null);
      if (!info?.connected || !info.text || FORBIDDEN_LABEL.test(info.text)) continue;
      if (!settings.expandReplies && /repl/i.test(info.text)) {
        result.repliesSkipped++;
        continue;
      }
      const key = info.key || info.text;
      if ((stuck.get(key) || 0) >= STUCK_AFTER) {
        result.stuckSkipped++;
        continue;
      }
      const before = await countComments(root);
      try {
        await clickRobust(h);
      } catch (err) {
        if (isTargetClosedError(err)) throw err;
        stuck.set(key, (stuck.get(key) || 0) + 1);
        continue;
      }
      result.clicked++;
      await pause(ctx);
      const quiet = await loading.waitQuiet(root);
      const after = await countComments(root);
      // Productive when comments appeared or the button went away / changed its text. A button
      // still there while something is loading is judged again next round.
      const now = await h.evaluate(elementLabelState).catch(() => null);
      const productive = after > before || !now?.connected || now.text !== info.text;
      if (productive) stuck.set(key, 0);
      else if (quiet) stuck.set(key, (stuck.get(key) || 0) + 1);
    }
  } finally {
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  }
  return result;
}

/**
 * The comment sort control inside root: by accessible name (whitespace-normalized), falling back
 * to [aria-haspopup=menu] buttons filtered by text.
 */
async function findSortButton(root, patterns) {
  const byName = root.getByRole('button', { name: patterns.sortButton }).first();
  if ((await byName.count()) > 0) return byName;
  return root.locator('[role="button"][aria-haspopup="menu"]').filter({ hasText: patterns.sortButton }).first();
}

/**
 * Switch the comment sort to "All comments" (step 3). Returns the final sort label and whether the
 * sort is now "All comments".
 */
async function switchSortToAll(page, root, ctx, initialLabel) {
  const { patterns, log } = ctx;
  if (patterns.sortAllItem.test(initialLabel)) {
    log('info', `Comment sort already: ${initialLabel}`);
    return { label: initialLabel, ok: true, clicked: false };
  }
  await clickRobust(await findSortButton(root, patterns));
  await pause(ctx, 0.5);

  // Menu items read "All comments" + a description line.
  let item = page.getByRole('menuitem', { name: patterns.sortAllItem }).first();
  try {
    await item.waitFor({ state: 'visible', timeout: 4000 });
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
    item = page.getByRole('menuitem').filter({ hasText: patterns.sortAllItem }).first();
  }
  try {
    await item.waitFor({ state: 'visible', timeout: 2000 });
    await clickRobust(item);
  } catch (err) {
    if (isTargetClosedError(err)) throw err;
    await closeOpenMenus(page);
    log('warn', `Could not find the "All comments" sort option; keeping "${initialLabel}" (some comments may stay hidden).`);
    return { label: initialLabel, ok: false, clicked: true };
  }

  // Wait (≤ 5 s) for the button to show the new sort.
  const until = Date.now() + 5000;
  let label = initialLabel;
  while (Date.now() < until) {
    await sleep(250, ctx.signal);
    try {
      const btn = await findSortButton(root, patterns);
      label = ((await btn.innerText({ timeout: 1000 })) || '').replace(/\s+/g, ' ').trim() || label;
    } catch (err) {
      if (isTargetClosedError(err)) throw err;
    }
    if (patterns.sortAllItem.test(label)) break;
  }
  await closeOpenMenus(page);
  if (patterns.sortAllItem.test(label)) {
    log('info', `Sorted comments: ${label}`);
    return { label, ok: true, clicked: true };
  }
  log('warn', `Sort did not switch to "All comments" (still "${label}"); some comments may stay hidden.`);
  return { label, ok: false, clicked: true };
}

// ------------------------------------------------------------------------------------------------
// preparePost

/**
 * Expand everything in the open post: post "See more", sort "All comments", then rounds of
 * scroll → expanders → comment "See more" until nothing changes (SPEC §7).
 *
 * `complete` is true only when the loop ended naturally with every comment believed loaded (no
 * unresponsive expanders, nothing still loading, replies expanded, sort "All comments" or no sort
 * control) — the runner uses it as `fullScan`, which marks unseen stored comments as missing.
 *
 * Throws (POST_CLOSED_MSG) when the post goes away while it is being expanded: the dialog was
 * closed, or the tab navigated elsewhere. The page behind must never be saved in its place.
 * @param {Page} page
 * @param {DriverCtx} ctx
 * @returns {Promise<{complete: boolean, rounds: number, clicks: number, rootKind: 'dialog'|'main', reason: string, commentCount: number}>}
 */
export async function preparePost(page, ctx) {
  const { settings, patterns, signal, log, progress } = ctx;
  const started = Date.now();
  const deadline = started + settings.postTimeoutSec * 1000;
  const probeOpts = probeOptions(patterns);
  const probe = () => evaluateWithRetry(page, probePage, probeOpts, signal);
  const loading = loadingTracker(ctx, deadline);

  try {
    // 1. Probe & root.
    let p = await probe();
    assertNotWalled(p);
    /** @type {'dialog'|'main'} */
    let rootKind = p.rootKind;
    if (rootKind !== 'dialog' && rootKind !== 'main') {
      throw new Error('No open post found on this page.');
    }
    let root = rootLocator(page, rootKind);
    let clicks = 0;
    let sortAttempts = 0;

    /** The post must still be on screen: never expand (or later save) the page behind it. */
    const assertRootAlive = async () => {
      let n = 0;
      try {
        n = await root.count();
      } catch (err) {
        if (isTargetClosedError(err)) throw err;
      }
      if (!n) throw new Error(POST_CLOSED_MSG);
    };

    /** Switch to "All comments" (counts the attempt); returns whether the sort is now right. */
    const sortToAll = async (label) => {
      sortAttempts++;
      progress({ phase: 'Sorting comments: All comments' });
      try {
        const r = await switchSortToAll(page, root, ctx, label);
        if (r.clicked) clicks += 2;
        return r.ok;
      } catch (err) {
        if (isAbortError(err) || isTargetClosedError(err)) throw err;
        await closeOpenMenus(page);
        log('warn', `Could not change the comment sort: ${errorMessage(err)}`);
        return false;
      } finally {
        await pause(ctx);
      }
    };

    // Empty post: nothing to expand.
    if (p.emptyState && !p.commentCount && !p.expanderCount) {
      log('info', 'Post has no comments yet.');
      return { complete: true, rounds: 0, clicks, rootKind, reason: 'no comments', commentCount: 0 };
    }

    /** Steps 2–3 for the current root (redone if the post moves from [role=main] into a dialog). */
    const setUpRoot = async () => {
      // 2. Post-level "See more".
      if (settings.expandSeeMore) {
        progress({ phase: 'Expanding post text' });
        const r = await clickSeeMore(root, ctx, 'post');
        clicks += r.clicked;
        if (r.clicked) log('info', 'Expanded the post text ("See more").');
      }

      // 3. Sort "All comments". Facebook can render the comment area (count, sort control) after
      //    the post body: wait (≤ 5 s) for it, then (≤ 5 s more) for the sort control when the post
      //    says it has comments.
      let sortLabel = p.sortLabel;
      for (let i = 0; i < 10 && !sortLabel && !p.emptyState && !p.feedbackFound; i++) {
        await sleep(500, signal);
        p = await probe();
        sortLabel = p.sortLabel;
      }
      for (let i = 0; i < 10 && !sortLabel && !p.emptyState && /[1-9]/.test(p.commentCountText || ''); i++) {
        await sleep(500, signal);
        p = await probe();
        sortLabel = p.sortLabel;
      }
      if (!sortLabel) {
        log('info', 'No comment sort control (post may have no comments).');
        return true;
      }
      if (!settings.sortAllComments) return patterns.sortAllItem.test(sortLabel);
      if (patterns.sortAllItem.test(sortLabel)) {
        log('info', `Comment sort already: ${sortLabel}`);
        return true;
      }
      return sortToAll(sortLabel);
    };
    let sortOk = await setUpRoot();

    // 4. Rounds.
    /** @type {Map<string, number>} */
    const stuck = new Map();
    let lastCount = await countComments(root);
    let maxCount = lastCount;
    let stableRounds = 0;
    let seeMoreStuckRounds = 0;
    let rounds = 0;
    let reason = '';
    let finished = false;
    let last = { stuckSkipped: 0, repliesSkipped: 0, loading: false };
    /** @type {{scrollTop: number, scrollHeight: number}|null} */
    let prevScroll = null;

    while (!finished) {
      throwIfAborted(signal);
      if (rounds >= settings.maxExpandRounds) {
        reason = `stopped after ${settings.maxExpandRounds} rounds (max rounds)`;
        break;
      }
      if (Date.now() > deadline) {
        reason = `stopped after ${settings.postTimeoutSec} s (time limit)`;
        break;
      }
      rounds++;
      progress({ phase: `Expanding comments — round ${rounds}, ${lastCount} loaded` });
      await assertRootAlive();

      // Facebook's count includes replies (and hidden/deleted comments): while fewer are loaded,
      // quiet rounds get a longer pause and one more is needed.
      const expected = parseCount(p.commentCountText);
      const behind = expected !== null && lastCount < expected - 1;

      // a. scroll
      await scrollRoot(page, root, ctx);
      await pause(ctx);
      if (behind && stableRounds > 0) await pause(ctx);

      // b. expanders
      await assertRootAlive();
      const ex = await clickExpanders(root, ctx, stuck, deadline, loading);
      clicks += ex.clicked;

      // c. comment "See more"
      let seeMore = { clicked: 0, remaining: 0 };
      if (settings.expandSeeMore) {
        seeMore = await clickSeeMore(root, ctx, 'comment');
        clicks += seeMore.clicked;
      }

      // d. measure, once whatever is loading (lazy comments, replies) has arrived.
      const quiet = await loading.waitQuiet(root);
      p = await probe();
      assertNotWalled(p);
      if (p.rootKind !== rootKind) {
        if (rootKind === 'main' && p.rootKind === 'dialog') {
          // The post's dialog mounted after all: start over in it.
          log('info', 'The post opened as a dialog; continuing there.');
          rootKind = 'dialog';
          root = rootLocator(page, rootKind);
          stuck.clear();
          stableRounds = 0;
          seeMoreStuckRounds = 0;
          prevScroll = null;
          sortOk = await setUpRoot();
          lastCount = await countComments(root);
          maxCount = lastCount;
          continue;
        }
        throw new Error(POST_CLOSED_MSG);
      }
      await assertRootAlive();
      const count = await countComments(root);
      if (count === 0 && maxCount > 0) throw new Error(POST_CLOSED_MSG);
      const grew = count > lastCount;
      maxCount = Math.max(maxCount, count);
      lastCount = count;

      // The sort can be missing at first or revert (re-render): switch again, a bounded number of times.
      let sortRetried = false;
      if (
        settings.sortAllComments &&
        p.sortLabel &&
        !patterns.sortAllItem.test(p.sortLabel) &&
        sortAttempts < MAX_SORT_ATTEMPTS
      ) {
        log('info', `Comment sort is "${p.sortLabel}"; switching to "All comments".`);
        sortOk = await sortToAll(p.sortLabel);
        sortRetried = true;
      }

      // A dialog counts as scrolled to the end when its scroller is at the bottom, or did not move
      // since the last round (it cannot go further).
      const s = p.scrollable || { found: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
      const atEnd =
        rootKind !== 'dialog' ||
        !s.found ||
        s.scrollHeight <= s.clientHeight + 2 ||
        s.scrollTop + s.clientHeight >= s.scrollHeight - 2 ||
        (!!prevScroll && prevScroll.scrollTop === s.scrollTop && prevScroll.scrollHeight === s.scrollHeight);
      prevScroll = { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight };
      stableRounds = !grew && quiet && atEnd && !sortRetried ? stableRounds + 1 : 0;

      // "See more" buttons that never go away must not keep the loop alive forever.
      let seeMoreLeft = settings.expandSeeMore ? seeMore.remaining : 0;
      if (seeMoreLeft > 0 && seeMore.clicked > 0 && !grew) seeMoreStuckRounds++;
      else if (seeMoreLeft === 0) seeMoreStuckRounds = 0;
      if (seeMoreStuckRounds >= SEE_MORE_GIVE_UP_ROUNDS) seeMoreLeft = 0;

      const parts = [`Round ${rounds}: clicked ${ex.clicked} expander${ex.clicked === 1 ? '' : 's'}`];
      if (seeMore.clicked) parts.push(`${seeMore.clicked} "See more"`);
      log(
        'info',
        `${parts.join(', ')}, ${count} comments loaded` +
          `${ex.stuckSkipped ? ` (${ex.stuckSkipped} unresponsive skipped)` : ''}${quiet ? '' : ' (still loading)'}`,
      );

      last = { stuckSkipped: ex.stuckSkipped, repliesSkipped: ex.repliesSkipped, loading: !quiet };
      if (ex.timedOut) {
        reason = `stopped after ${settings.postTimeoutSec} s (time limit)`;
        break;
      }
      const needed = STABLE_ROUNDS_NEEDED + (expected !== null && count < expected - 1 ? 1 : 0);
      if (ex.clicked === 0 && stableRounds >= needed && seeMoreLeft === 0) finished = true;
    }
    await assertRootAlive();

    // The sort shown at the end decides (it may have been switched late, or reverted).
    if (p.sortLabel) sortOk = patterns.sortAllItem.test(p.sortLabel);

    // Completeness (drives missing-marking in the db, so be conservative).
    const problems = [];
    if (!finished) problems.push(reason);
    if (last.stuckSkipped) problems.push(`${last.stuckSkipped} expander(s) did not respond`);
    if (last.repliesSkipped) problems.push('replies not expanded (setting off)');
    if (last.loading) problems.push('comments were still loading');
    if (!sortOk) problems.push('comments not sorted by "All comments"');
    if (lastCount < maxCount) problems.push(`the number of comments went down (${maxCount} → ${lastCount})`);
    const complete = problems.length === 0;
    const resultReason = complete ? 'all comments loaded' : problems.join('; ');
    log(
      complete ? 'info' : 'warn',
      complete
        ? `All comments loaded: ${lastCount} after ${rounds} round${rounds === 1 ? '' : 's'} (${clicks} click${clicks === 1 ? '' : 's'}).`
        : `Expansion incomplete — ${resultReason}. ${lastCount} comments loaded.`,
    );
    return { complete, rounds, clicks, rootKind, reason: resultReason, commentCount: lastCount };
  } finally {
    // 5. Never leave a menu open.
    if (!signal?.aborted) await closeOpenMenus(page);
  }
}

// ------------------------------------------------------------------------------------------------
// collectFeedLinks

/** Hover candidates tried per scroll round. */
const MAX_HOVERS_PER_ROUND = 10;

/**
 * Scroll the group feed and collect post ids incrementally (the feed is virtualized).
 * collectFeedPosts finds ids from header links, React data, other post links or preview comments;
 * posts still without an id get their header link hovered (data-fbcs-hover) so Facebook fills in
 * the href, which is read at once (it can be cleared when the pointer leaves).
 * Always logs a one-line summary of where the ids came from; when none were found, also a warning
 * with the scan's privacy-safe diagnostics (shapes only, no names, text or ids).
 * @param {Page} page
 * @param {DriverCtx} ctx
 * @returns {Promise<Array<{postId: string, url: string, authorName: string|null, textPreview: string, dateText: string|null, commentCountText: string|null}>>}
 */
export async function collectFeedLinks(page, ctx) {
  const { settings, signal, log, progress } = ctx;
  const maxPosts = settings.maxPosts;
  const settingsSlug = parseFbUrl(settings.groupUrl)?.groupSlug ?? null;
  /** @type {string|null} the feed page's own group (from collectFeedPosts) */
  let pageSlug = null;
  /** @type {Map<string, any>} */
  const found = new Map();
  const sources = { link: 0, react: 0, linkAny: 0, comments: 0, hover: 0 };
  const diag = { feeds: 0, rendered: 0, containerMode: 'article', missing: 0, hoverCandidates: 0, sampleShapes: /** @type {any[]} */ ([]) };

  // Wait for the feed (and detect login walls / blocks early).
  const feedDeadline = Date.now() + 30000;
  while (!(await evaluateWithRetry(page, pageFeedReady, undefined, signal))) {
    if (Date.now() > feedDeadline) {
      const probe = await evaluateWithRetry(page, probePage, probeOptions(ctx.patterns), signal).catch(() => null);
      assertNotWalled(probe);
      throw new Error('The group feed did not load. Are you a member of this group, and is the group URL right?');
    }
    await sleep(500, signal);
  }

  await evaluateWithRetry(page, scrollPageToTop, undefined, signal);
  await pause(ctx);
  const vp = await evaluateWithRetry(page, pageViewport, undefined, signal);
  const center = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) };
  await page.mouse.move(center.x, center.y);

  let hoverSeq = 0;
  let noGrowth = 0;
  let round = 0;

  /** @param {{postId: string, permalinkHref?: string|null, authorName?: string|null, textPreview?: string, dateText?: string|null, commentCountText?: string|null}} p @param {string} source @param {string|null} [slugHint] */
  const addPost = (p, source, slugHint = null) => {
    if (!p?.postId || found.has(p.postId)) return;
    const slug = slugHint || (p.permalinkHref && parseFbUrl(p.permalinkHref)?.groupSlug) || pageSlug || settingsSlug;
    if (!slug) return;
    found.set(p.postId, {
      postId: p.postId,
      url: canonicalPostUrl(slug, p.postId),
      authorName: p.authorName ?? null,
      textPreview: p.textPreview ?? '',
      dateText: p.dateText ?? null,
      commentCountText: p.commentCountText ?? null,
    });
    const key = source === 'link-any' ? 'linkAny' : source;
    if (key in sources) sources[/** @type {keyof typeof sources} */ (key)]++;
  };

  /** One scan: add its posts, merge its diagnostics. */
  const scan = async () => {
    const res = await evaluateWithRetry(page, collectFeedPosts, { markHoverFrom: hoverSeq }, signal);
    hoverSeq += res?.missing?.length || 0;
    if (res?.groupSlug && !pageSlug) pageSlug = res.groupSlug;
    for (const p of res?.posts || []) addPost(p, p.idSource || 'link');
    const d = res?.diag;
    if (d) {
      diag.feeds = Math.max(diag.feeds, d.feeds || 0);
      diag.rendered = Math.max(diag.rendered, d.rendered || 0);
      if (d.containerMode === 'children') diag.containerMode = 'children';
      for (const shape of d.sampleShapes || []) if (diag.sampleShapes.length < 3) diag.sampleShapes.push(shape);
    }
    return res;
  };

  while (found.size < maxPosts && noGrowth < 6) {
    throwIfAborted(signal);
    round++;
    const before = found.size;

    let res = await scan();

    // Hover the header links of posts still without an id; read each href at once.
    const missing = (res?.missing || []).slice(0, MAX_HOVERS_PER_ROUND);
    if (missing.length && found.size < maxPosts) {
      diag.hoverCandidates += missing.length;
      for (const m of missing) {
        throwIfAborted(signal);
        const id = String(m.hoverId).replace(/"/g, '');
        let hit = null;
        try {
          await page.hover(`[data-fbcs-hover="${id}"]`, { timeout: 2000 });
          hit = await evaluateWithRetry(page, hoveredPostLink, id, signal);
          if (!hit) {
            await sleep(200, signal);
            hit = await evaluateWithRetry(page, hoveredPostLink, id, signal);
          }
          if (hit) {
            addPost({ postId: hit.postId, permalinkHref: hit.href }, 'hover', hit.groupSlug);
          }
        } catch (err) {
          if (isAbortError(err) || isTargetClosedError(err)) throw err;
        }
        // Hover each post at most once (hoveredPostLink marks the ones it read; this covers a
        // failed hover): hovering scrolls back to it, so a post that never yields an id would
        // otherwise pin the scroll position and stop the feed from growing.
        if (!hit) {
          await page.evaluate(markHoverTried, id).catch((err) => {
            if (isTargetClosedError(err)) throw err;
          });
        }
      }
      res = await scan();
      await page.mouse.move(center.x, center.y);
    }
    // Posts of this round still without an id: the last scan's count (a hovered post that gave its
    // id carries data-fbcs-post-id, so the re-scan already counts it as found).
    const unresolved = res?.diag?.missing ?? res?.missing?.length ?? 0;
    diag.missing = Math.max(diag.missing, unresolved);

    noGrowth = found.size > before ? 0 : noGrowth + 1;
    progress({ phase: `Collecting posts from the feed: ${Math.min(found.size, maxPosts)}/${maxPosts}` });
    if (found.size >= maxPosts) break;

    await page.mouse.wheel(0, 1600);
    await pause(ctx);
  }

  const list = [...found.values()].slice(0, maxPosts);
  log(
    'info',
    `Feed scan: ${found.size + diag.missing} posts seen — ids from links ${sources.link + sources.linkAny}, ` +
      `page data ${sources.react}, comment links ${sources.comments}, hover ${sources.hover}; ` +
      `${diag.missing} without an id.`,
  );
  if (!list.length) {
    const report = {
      feeds: diag.feeds,
      rendered: diag.rendered,
      containerMode: diag.containerMode,
      hoverCandidates: diag.hoverCandidates,
      sampleShapes: diag.sampleShapes,
    };
    log(
      'warn',
      `No post ids found in the feed. Scan details: ${JSON.stringify(report)}. ` +
        "Click 'Copy diagnostics' in the side panel and send the report.",
    );
  }
  if (found.size < maxPosts) {
    log('info', `Feed stopped growing after ${round} scrolls: collected ${list.length} post link${list.length === 1 ? '' : 's'}.`);
  } else {
    log('info', `Collected ${list.length} post links from the feed.`);
  }
  return list;
}

/** @param {unknown} err */
function errorMessage(err) {
  return String(/** @type {any} */ (err)?.message ?? err ?? 'unknown error').split('\n')[0];
}
