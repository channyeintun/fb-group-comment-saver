// Runs one save job at a time (SPEC.md §7): quick / post / crawl.
// State lives in memory and is mirrored to chrome.storage.session[JOB_STATE_KEY] so the UI can
// observe it via chrome.storage.onChanged.

import { JOB_STATE_KEY, MSG } from '../lib/constants.js';
import { buildGroupFeedUrl, compilePatterns, getSettings, isGroupFeedUrl, sanitizeSettings } from '../lib/settings.js';
import { classifyTabUrl, parseFbUrl } from '../lib/fb-url.js';
import { normalizeExtraction } from '../lib/normalize.js';
import { postsScannedSince, savePostBundle } from '../lib/db.js';
import { extractRaw } from '../page/extract.js';
import {
  AbortError,
  FatalError,
  POST_CLOSED_MSG,
  actionDelay,
  collectFeedLinks,
  isAbortError,
  isPageConnected,
  isTargetClosedError,
  preparePost,
  sleep,
  throwIfAborted,
  waitForPostRoot,
  withPage,
} from './pw-driver.js';

/** @typedef {import('../lib/constants.js').Settings} Settings */
/** @typedef {'quick'|'post'|'crawl'} JobMode */
/**
 * @typedef {object} JobState
 * @property {string|null} id
 * @property {JobMode|null} mode
 * @property {'idle'|'running'|'stopping'|'done'|'stopped'|'error'|'interrupted'} status
 * @property {number|null} tabId
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string} phase              human-readable current step
 * @property {number} postsTotal
 * @property {number} postsDone          posts processed (saved or failed)
 * @property {number} postsFailed
 * @property {number} commentsSeen
 * @property {number} inserted
 * @property {number} updated
 * @property {number} markedMissing
 * @property {string|null} currentPostUrl
 * @property {string|null} error
 * @property {Array<{t: string, level: 'info'|'warn'|'error', msg: string}>} log   last 300 entries
 */

const MODES = ['quick', 'post', 'crawl'];
const MODE_LABEL = {
  quick: 'quick save (visible comments only)',
  post: 'saving all comments of this post',
  crawl: 'group crawl',
};
const LOG_LIMIT = 300;
const PERSIST_MIN_INTERVAL_MS = 250; // ≤ 4 writes/s
const KEEP_ALIVE_MS = 20000;
const POST_LOAD_TIMEOUT_MS = 30000;
const NAV_TIMEOUT_MS = 45000;
/**
 * Safety net for full scans: one that would mark more than this share of a post's stored comments
 * as missing (and at least 3 of them) is saved as a partial scan instead (see db.savePostBundle).
 */
const MAX_MISSING_RATIO = 0.25;

/** @returns {JobState} */
function idleState() {
  return {
    id: null,
    mode: null,
    status: 'idle',
    tabId: null,
    startedAt: null,
    finishedAt: null,
    phase: '',
    postsTotal: 0,
    postsDone: 0,
    postsFailed: 0,
    commentsSeen: 0,
    inserted: 0,
    updated: 0,
    markedMissing: 0,
    currentPostUrl: null,
    error: null,
    log: [],
  };
}

/** @type {JobState} */
let state = idleState();
/** In-flight job bookkeeping; null when no job is running. */
let active = /** @type {null | {controller: AbortController, stopRequested: boolean, detachReason: string|null}} */ (null);

// ------------------------------------------------------------------------------------------------
// Persistence (throttled) & logging

let lastWriteAt = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let writeTimer = null;
let writeChain = Promise.resolve();

function writeNow() {
  lastWriteAt = Date.now();
  const snapshot = JSON.parse(JSON.stringify(state));
  writeChain = writeChain
    .then(() => chrome.storage.session.set({ [JOB_STATE_KEY]: snapshot }))
    .catch((err) => console.warn('[job] could not persist job state:', err));
  return writeChain;
}

/**
 * Mirror state to chrome.storage.session. Throttled to ≤ 4 writes/s unless `force`
 * (status changes and the end of a job are always written immediately).
 * @param {boolean} [force]
 */
function persist(force = false) {
  if (force) {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    return writeNow();
  }
  if (writeTimer) return writeChain;
  const wait = Math.max(0, lastWriteAt + PERSIST_MIN_INTERVAL_MS - Date.now());
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
  }, wait);
  return writeChain;
}

/**
 * @param {'info'|'warn'|'error'} level
 * @param {string} msg
 */
function log(level, msg) {
  state.log.push({ t: new Date().toISOString(), level, msg });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[job] ${msg}`);
  persist();
}

/** @param {JobState['status']} status */
function setStatus(status) {
  state.status = status;
  return persist(true);
}

/** Apply a partial state update coming from the driver/runner. */
function progress(patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const [key, value] of Object.entries(patch)) {
    if (key in state && key !== 'log' && key !== 'status') /** @type {any} */ (state)[key] = value;
  }
  persist();
}

/** Tell open UIs that the archive changed. */
function broadcastDbChanged(postIds) {
  try {
    const p = chrome.runtime.sendMessage({ type: MSG.DB_CHANGED, postIds });
    if (p && typeof p.catch === 'function') p.catch(() => {}); // "Receiving end does not exist"
  } catch {
    // no receiver
  }
}

// ------------------------------------------------------------------------------------------------
// Startup recovery

/** @type {Promise<void>|null} */
let ready = null;

/**
 * Call once when the service worker starts (idempotent): loads the persisted JobState; a job still
 * marked running/stopping died with the previous worker, so it is rewritten as 'interrupted'.
 * @returns {Promise<void>}
 */
export function init() {
  if (!ready) ready = recoverInterrupted();
  return ready;
}

async function recoverInterrupted() {
  try {
    const got = await chrome.storage.session.get(JOB_STATE_KEY);
    const stored = got?.[JOB_STATE_KEY];
    if (!stored || typeof stored !== 'object' || active) return;
    state = { ...idleState(), ...stored, log: Array.isArray(stored.log) ? stored.log : [] };
    if (state.status === 'running' || state.status === 'stopping') {
      state.status = 'interrupted';
      state.finishedAt = new Date().toISOString();
      state.phase = 'Interrupted';
      state.error = 'The extension was restarted while this job was running. Start it again to continue.';
      state.currentPostUrl = null;
      log('warn', 'Job interrupted: the extension background was restarted (Chrome stopped the service worker).');
      await persist(true);
      if (typeof state.tabId === 'number') {
        // Best effort: a leftover debugger session would keep the "debugging" bar visible.
        await chrome.debugger?.detach({ tabId: state.tabId })?.catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[job] could not restore job state:', err);
  }
}

// ------------------------------------------------------------------------------------------------
// Public API

/** @returns {JobState} a copy of the current job state */
export function getState() {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Start a job. Resolves as soon as the job is running (the job itself continues in the
 * background); rejects if a job is already running or the arguments are invalid.
 * @param {JobMode} mode
 * @param {number} tabId
 * @param {Partial<Settings>} [overrides]
 * @returns {Promise<void>}
 */
export async function start(mode, tabId, overrides) {
  await init();
  if (active) throw new Error('A job is already running. Stop it first.');
  if (!MODES.includes(mode)) throw new Error(`Unknown job mode: ${mode}`);
  if (!Number.isInteger(tabId)) throw new Error('No tab to work on.');

  const controller = new AbortController();
  active = { controller, stopRequested: false, detachReason: null };
  state = {
    ...idleState(),
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    mode,
    status: 'running',
    tabId,
    startedAt: new Date().toISOString(),
    phase: 'Starting',
  };
  log('info', `Started ${MODE_LABEL[mode]}.`);
  await persist(true);

  // Not awaited: the job runs in the background.
  runJob(mode, tabId, overrides, active).catch((err) => console.error('[job] unexpected failure', err));
}

/** Request the running job to stop; it ends with status 'stopped'. */
export function stop() {
  if (!active || active.stopRequested) return;
  active.stopRequested = true;
  state.phase = 'Stopping…';
  log('info', 'Stop requested.');
  setStatus('stopping');
  active.controller.abort(new AbortError());
}

// ------------------------------------------------------------------------------------------------
// Job execution

/**
 * @param {JobMode} mode
 * @param {number} tabId
 * @param {Partial<Settings>|undefined} overrides
 * @param {NonNullable<typeof active>} job
 */
async function runJob(mode, tabId, overrides, job) {
  const { signal } = job.controller;
  // Chrome may stop an idle-looking service worker; an extension API call every 20 s prevents it.
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, KEEP_ALIVE_MS);

  try {
    const settings = sanitizeSettings({ ...(await getSettings()), ...(overrides || {}) });
    const patterns = compilePatterns(settings);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('The tab is no longer open.');

    /** @type {RunCtx} */
    const rc = { mode, job, signal, settings, patterns, tab };
    if (mode === 'quick') await runQuick(rc);
    else if (mode === 'post') await runPost(rc);
    else await runCrawl(rc);

    throwIfAborted(signal);
    state.phase = 'Finished';
    state.currentPostUrl = null;
    log('info', `Done: ${summaryLine()}`);
    state.finishedAt = new Date().toISOString();
    await setStatus('done');
  } catch (err) {
    // A debugger detach usually surfaces first as "target closed"; give its event a moment.
    if (!job.detachReason && isTargetClosedError(err)) await sleep(200);
    state.finishedAt = new Date().toISOString();
    state.currentPostUrl = null;
    if (job.detachReason) {
      state.error = detachMessage(job.detachReason);
      state.phase = 'Failed';
      log('error', state.error);
      await setStatus('error');
    } else if (job.stopRequested && (isAbortError(err) || signal.aborted)) {
      state.phase = 'Stopped';
      log('info', `Stopped by you. So far: ${summaryLine()}`);
      await setStatus('stopped');
    } else {
      state.error = friendlyError(err);
      state.phase = 'Failed';
      log('error', state.error);
      await setStatus('error');
    }
  } finally {
    clearInterval(keepAlive);
    active = null;
    await persist(true);
  }
}

/**
 * @typedef {object} RunCtx
 * @property {JobMode} mode
 * @property {NonNullable<typeof active>} job
 * @property {AbortSignal} signal
 * @property {Settings} settings
 * @property {ReturnType<typeof compilePatterns>} patterns
 * @property {chrome.tabs.Tab} tab
 */

/** Quick save: extract what is rendered right now, no debugger. */
async function runQuick(rc) {
  const { tab } = rc;
  const tabKind = assertFacebookTab(tab.url);
  state.postsTotal = 1;
  progress({ phase: 'Reading visible comments', currentPostUrl: tab.url ?? null });
  // MAIN world: Facebook's React data (fiber props on DOM nodes) is invisible from the isolated
  // world, and some accounts get markup where only that data names the post/comment ids.
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractRaw,
    args: [{ scope: 'auto' }],
    world: 'MAIN',
  });
  const raw = injection?.result;
  if (!raw) throw new Error('Could not read the page (no result from the page script).');
  throwIfAborted(rc.signal);
  if (raw.rootKind === 'none' || !raw.posts?.length) {
    throw new Error('No post found on this page. Open a post or the group feed and try again.');
  }
  // The settings' group is a fallback only on group pages: a post found on the home feed or a
  // profile is not filed under the default group.
  const onGroupPage = tabKind.kind === 'group' || tabKind.kind === 'post';
  const saved = await saveExtraction(raw, {
    mode: 'quick',
    fullScan: false,
    fallbackGroupSlug: onGroupPage ? (tabKind.groupSlug ?? groupSlugOf(rc.settings)) : null,
  });
  state.postsTotal = Math.max(saved, 1);
  state.postsDone = saved;
  persist();
}

/** Post mode: expand everything in the open post with Playwright, then save. */
async function runPost(rc) {
  const { tab, signal, settings } = rc;
  const tabKind = classifyTabUrl(tab.url || '');
  if (tabKind.kind === 'mobile') throw new Error('m.facebook.com is not supported. Open the post on www.facebook.com.');
  if (tabKind.kind !== 'post') throw new Error('Open a post first (a facebook.com/groups/…/posts/… page).');
  state.postsTotal = 1;
  progress({ phase: 'Attaching to the tab', currentPostUrl: tab.url ?? null });

  await withPage(
    tab.id,
    async (page) => {
      logDebuggerHint();
      await waitForPostRoot(page, { timeoutMs: POST_LOAD_TIMEOUT_MS, signal });
      await processOpenPost(page, rc, {
        prefix: '',
        fallbackGroupSlug: tabKind.groupSlug ?? groupSlugOf(settings),
        expectedPostId: tabKind.postId,
      });
      state.postsDone = 1;
      persist();
    },
    { onDetach: (reason) => onDebuggerDetached(rc.job, reason) },
  );
}

/** Crawl mode: collect post links from the group feed, then save each post fully. */
async function runCrawl(rc) {
  const { tab, signal, settings } = rc;
  const groupSlug = groupSlugOf(settings);
  if (!groupSlug) throw new Error(`The group URL "${settings.groupUrl}" is not a facebook.com/groups/… address.`);
  const tabKind = classifyTabUrl(tab.url || '');
  if (tabKind.kind === 'other' || tabKind.kind === 'mobile') {
    throw new Error('Use a www.facebook.com (or web.facebook.com) tab for crawling.');
  }
  const feedUrl = buildGroupFeedUrl(settings);

  progress({ phase: 'Attaching to the tab' });
  await withPage(
    tab.id,
    async (page) => {
      logDebuggerHint();
      // Stay only when the tab shows exactly this feed in the chosen order (not another group
      // page such as Members, a member's posts or another sort).
      if (!isGroupFeedUrl(page.url() || tab.url || '', settings)) {
        progress({ phase: 'Opening the group feed' });
        log('info', `Opening the group feed: ${feedUrl}`);
        await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await sleep(actionDelay(settings), signal);
      }

      // 1. Collect links.
      progress({ phase: 'Collecting posts from the feed' });
      let links = await collectFeedLinks(page, driverCtx(rc, ''));
      throwIfAborted(signal);

      // 2. Skip recently fully scanned posts.
      if (settings.skipSavedWithinHours > 0 && links.length) {
        const recent = await postsScannedSince(Date.now() - settings.skipSavedWithinHours * 3600 * 1000);
        const kept = links.filter((l) => !recent.has(l.postId));
        if (kept.length < links.length) {
          log('info', `Skipping ${links.length - kept.length} post(s) fully scanned within ${settings.skipSavedWithinHours} h.`);
        }
        links = kept;
      }
      state.postsTotal = links.length;
      persist();
      if (!links.length) {
        log('info', 'Nothing to save.');
        return;
      }

      // 3. Visit each post. Per-post errors are logged and counted; fatal ones end the crawl.
      for (let i = 0; i < links.length; i++) {
        throwIfAborted(signal);
        const link = links[i];
        const prefix = `Post ${i + 1}/${links.length}: `;
        progress({ phase: `${prefix}opening`, currentPostUrl: link.url });
        // One line per post: a name can hold line breaks (a badge line under it), and diagnostics
        // (src/lib/diagnostics.js) masks the "(name)" at the end of this line.
        const author = collapse(link.authorName);
        log('info', `${prefix}${link.url}${author ? ` (${author})` : ''}`);
        try {
          await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
          await waitForPostRoot(page, { timeoutMs: POST_LOAD_TIMEOUT_MS, signal });
          await processOpenPost(page, rc, { prefix, fallbackGroupSlug: groupSlug, expectedPostId: link.postId });
        } catch (err) {
          if (isAbortError(err) || err instanceof FatalError || isTargetClosedError(err) || rc.job.detachReason) {
            throw err;
          }
          if (!(await isPageConnected(page, tab.id))) throw err; // withPage reports the lost connection
          state.postsFailed++;
          log('error', `${prefix}failed — ${friendlyError(err)}`);
        }
        state.postsDone = i + 1;
        persist();
        if (i < links.length - 1) await sleep(actionDelay(settings, 1.5), signal);
      }

      // 4. Back to the group.
      if (settings.returnToGroupAfterCrawl) {
        throwIfAborted(signal);
        progress({ phase: 'Returning to the group', currentPostUrl: null });
        await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch((err) => {
          if (isTargetClosedError(err)) throw err;
          log('warn', `Could not return to the group feed: ${friendlyError(err)}`);
        });
      }
    },
    { onDetach: (reason) => onDebuggerDetached(rc.job, reason) },
  );
}

/**
 * preparePost → extract → save for the post currently open in `page`.
 * Only the post that was expanded is saved: if the page no longer shows exactly one open post
 * (dialog closed, tab navigated), nothing is saved; a full scan is claimed only when the extracted
 * root and post id are the ones that were prepared.
 * @param {any} page
 * @param {RunCtx} rc
 * @param {{prefix: string, fallbackGroupSlug: string|null, expectedPostId: string|null}} opts
 */
async function processOpenPost(page, rc, { prefix, fallbackGroupSlug, expectedPostId }) {
  const result = await preparePost(page, driverCtx(rc, prefix));
  throwIfAborted(rc.signal);
  progress({ phase: `${prefix}saving` });
  const raw = await page.evaluate(extractRaw, { scope: 'auto' });
  if (!raw || (raw.rootKind !== 'dialog' && raw.rootKind !== 'main') || raw.posts?.length !== 1) {
    throw new Error(POST_CLOSED_MSG);
  }
  let fullScan = result.complete;
  if (fullScan && raw.rootKind !== result.rootKind) {
    log('warn', `${prefix}the post moved (${result.rootKind} → ${raw.rootKind}) after expanding; saving it as a partial scan.`);
    fullScan = false;
  }
  await saveExtraction(raw, { mode: rc.mode, fullScan, fallbackGroupSlug, expectedPostId });
}

/**
 * Whether a normalized post is the one the job opened. URL ids can take another form than the
 * numeric id in comment links (pfbid…); such an id is accepted when the page is still on that URL.
 * @param {string} postId  normalized post id
 * @param {string} expected  id from the tab / crawl link
 * @param {any} raw  RawExtraction
 */
function isExpectedPost(postId, expected, raw) {
  if (postId === expected) return true;
  return !/^\d+$/.test(expected) && parseFbUrl(raw?.pageUrl).postId === expected;
}

/**
 * Normalize + save. Returns the number of posts saved.
 * `fullScan` applies only to the expected post (when one is given); a post with another id, or a
 * full scan that would mark too many stored comments missing, is saved as a partial scan.
 * @param {any} raw  RawExtraction
 * @param {{mode: JobMode, fullScan: boolean, fallbackGroupSlug: string|null, expectedPostId?: string|null}} opts
 */
async function saveExtraction(raw, { mode, fullScan, fallbackGroupSlug, expectedPostId = null }) {
  const savedAt = new Date().toISOString();
  const { posts, comments, warnings } = normalizeExtraction(raw, { savedAt, fallbackGroupSlug, mode });
  for (const w of warnings || []) log('warn', w);
  if (!posts.length) throw new Error('Could not identify the post (no post id found on the page).');

  for (const post of posts) {
    const own = comments.filter((c) => c.postId === post.id);
    let full = fullScan && posts.length === 1;
    if (full && expectedPostId && !isExpectedPost(post.id, expectedPostId, raw)) {
      log('warn', `The page showed post ${post.id}, not ${expectedPostId}; saving it as a partial scan.`);
      full = false;
    }
    const res = await savePostBundle(post, own, {
      fullScan: full,
      now: savedAt,
      maxMissingRatio: full ? MAX_MISSING_RATIO : undefined,
    });
    if (res.fullScanDowngraded) {
      log(
        'warn',
        `Post ${post.id}: this scan would mark ${res.wouldMarkMissing} saved comments as no longer found — ` +
          'too many to trust. Saved as a partial scan instead (nothing marked missing).',
      );
      full = false;
    }
    state.commentsSeen += own.length;
    state.inserted += res.inserted;
    state.updated += res.updated;
    state.markedMissing += res.markedMissing;
    const expected =
      typeof post.commentCountExpected === 'number' && post.commentCountExpected !== own.length
        ? ` — Facebook shows ${post.commentCountExpected}`
        : '';
    log(
      'info',
      `Saved post ${post.id}: ${own.length} comment${own.length === 1 ? '' : 's'} ` +
        `(${res.inserted} new, ${res.updated} updated, ${res.markedMissing} missing)${expected}` +
        `${full ? '' : mode === 'quick' ? '' : ' [incomplete scan]'}`,
    );
    broadcastDbChanged([post.id]);
  }
  return posts.length;
}

/** Driver context; `prefix` is prepended to phase texts (e.g. "Post 3/20: "). */
function driverCtx(rc, prefix) {
  return {
    settings: rc.settings,
    patterns: rc.patterns,
    signal: rc.signal,
    log,
    progress: (patch) => {
      if (patch && typeof patch.phase === 'string' && prefix) patch = { ...patch, phase: prefix + patch.phase };
      progress(patch);
    },
  };
}

/** chrome.debugger ended the session on its own (Cancel on the infobar, tab closed, DevTools…). */
function onDebuggerDetached(job, reason) {
  if (job !== active || job.detachReason) return;
  job.detachReason = reason;
  console.warn('[job] debugger detached:', reason);
  job.controller.abort(new AbortError('Debugger detached'));
}

function detachMessage(reason) {
  if (reason === 'canceled_by_user') {
    return 'Stopped: the debugging session was cancelled (the "Cancel" button on Chrome\'s "started debugging this browser" bar). Leave that bar open while saving.';
  }
  if (reason === 'target_closed') return 'Stopped: the tab was closed or crashed while saving.';
  return `Stopped: Chrome ended the debugging session (${reason}). If DevTools was opened on the tab, close it and try again.`;
}

function logDebuggerHint() {
  log('info', 'Attached to the tab. Chrome shows a "started debugging this browser" bar while saving — don\'t click Cancel; keep the tab visible.');
}

/** Whitespace runs (line breaks included) → one space. @param {unknown} s */
function collapse(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** @param {string|undefined} url */
function assertFacebookTab(url) {
  const kind = classifyTabUrl(url || '');
  if (kind.kind === 'mobile') throw new Error('m.facebook.com is not supported. Use www.facebook.com.');
  if (kind.kind === 'other') throw new Error('Open a Facebook post or group page first.');
  return kind;
}

/** @param {Settings} settings */
function groupSlugOf(settings) {
  try {
    return parseFbUrl(buildGroupFeedUrl(settings))?.groupSlug ?? null;
  } catch {
    return null;
  }
}

function summaryLine() {
  const parts = [];
  if (state.mode === 'crawl') parts.push(`${state.postsDone - state.postsFailed}/${state.postsTotal} posts saved`);
  if (state.postsFailed) parts.push(`${state.postsFailed} failed`);
  parts.push(`${state.commentsSeen} comments seen`, `${state.inserted} new`, `${state.updated} updated`);
  if (state.markedMissing) parts.push(`${state.markedMissing} no longer found`);
  return `${parts.join(', ')}.`;
}

/** First line of an error message, with Playwright noise translated. */
function friendlyError(err) {
  if (err instanceof FatalError) return err.message;
  const msg = String(/** @type {any} */ (err)?.message ?? err ?? 'Unknown error');
  if (isTargetClosedError(err)) return 'Lost the connection to the tab (it was closed, or debugging was cancelled).';
  if (/Cannot access contents of (url|the page)|Missing host permission/i.test(msg)) {
    return 'The extension cannot access this page. Use a www.facebook.com or web.facebook.com tab.';
  }
  if (/Another debugger is already attached/i.test(msg)) {
    return 'Another debugger (DevTools or another extension) is attached to this tab. Close it and try again.';
  }
  if (/Timeout \d+ms exceeded/i.test(msg) && /goto|navigat/i.test(msg)) return 'The page took too long to load.';
  return msg.split('\n')[0].replace(/^\w+\.\w+: /, '');
}
