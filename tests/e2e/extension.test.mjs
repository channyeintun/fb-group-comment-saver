// End-to-end tests: the built extension (dist/) loaded into Playwright's Chromium, with
// https://www.facebook.com/** routed to the HTML fixtures in tests/fixtures.
//
// Jobs are started the way the side panel does it: chrome.runtime.sendMessage({type:'START_JOB', …})
// from an extension page (sidepanel.html opened in a tab). The service worker then drives the
// fixture tab with playwright-crx over chrome.debugger, exactly as it would drive Facebook.
//
// Run with `npm run test:e2e` (builds dist/ first). Scenarios run in order and share one browser
// profile and one archive, like a real user session.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const FIXTURES = path.join(ROOT, 'tests/fixtures');

const FB = 'https://www.facebook.com';
const GROUP_URL = `${FB}/groups/testgroup`;
const postUrl = (id, query = '') => `${GROUP_URL}/posts/${id}/${query}`;
/** Fast pacing for the fixtures (their loaders take 300 ms). */
const FAST = { actionDelayMs: 150 };
const JOB_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT = { timeout: 300_000 };

/** Expected DOM pre-order of post 1001 once fully expanded (see tests/fixtures/post-dialog.html). */
const FULL_ORDER_1001 = [
  '2001', '3001', '3002', '3003', '2002', '2011', '2003', '2004', '3004', '3005',
  '2005', '2012', '2006', '2007', '2008', '2009', '2010',
];

/** @type {import('playwright').BrowserContext} */ let ctx;
/** @type {import('playwright').Worker} */ let sw;
/** @type {import('playwright').Page} */ let ui; // sidepanel.html in a tab: the "UI" that sends messages
/** @type {import('playwright').Page} */ let fb; // the Facebook (fixture) tab the jobs work on
let extId = '';
const uiErrors = [];
const swErrors = [];

// ------------------------------------------------------------------------------------------------
// Harness

/**
 * Markup variant for every fixture page served (see the variant notes in tests/fixtures/*.html):
 * injected as window.FBCS_FIXTURE_VARIANT, so the canonical post URLs a crawl opens keep it.
 */
let fixtureVariant = '';

function serveFixture(route) {
  const url = new URL(route.request().url());
  let file = null;
  if (/^\/groups\/[^/]+\/(posts|permalink)\/9999\/?$/.test(url.pathname)) file = 'post-empty.html';
  else if (/^\/groups\/[^/]+\/(posts|permalink)\/[\w.-]+\/?$/.test(url.pathname)) file = 'post-dialog.html';
  else if (/^\/groups\/[^/]+\/?$/.test(url.pathname)) file = 'feed.html';
  if (!file) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  let body = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
  if (fixtureVariant) {
    body = body.replace('<head>', `<head><script>window.FBCS_FIXTURE_VARIANT = ${JSON.stringify(fixtureVariant)};</script>`);
  }
  return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
}

/** Collect console errors / uncaught exceptions of an extension page. */
function watchErrors(page, sink, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') sink.push(`${label} console: ${m.text()}`);
  });
  page.on('pageerror', (err) => sink.push(`${label} pageerror: ${err.message}`));
}

/** Send a runtime message from the UI page (as the side panel does). */
function send(msg) {
  return ui.evaluate((m) => chrome.runtime.sendMessage(m), msg);
}

async function readJobState() {
  return ui.evaluate(async () => (await chrome.storage.session.get('jobState')).jobState ?? null);
}

/** Tab id of the fixture tab, as the extension sees it. */
async function fbTabId() {
  const id = await ui.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/*' });
    return tabs.length === 1 ? tabs[0].id : null;
  });
  assert.ok(Number.isInteger(id), 'exactly one facebook.com tab should be open');
  return id;
}

/**
 * Navigate the fixture tab, start a job from the UI page, wait until it has finished.
 * @returns {Promise<any>} final JobState
 */
async function runJob(mode, { url, overrides = {}, onRunning } = {}) {
  if (url) await fb.goto(url, { waitUntil: 'load' });
  await fb.bringToFront(); // Facebook (and the fixtures' lazy loading) need a visible tab
  const tabId = await fbTabId();
  const res = await send({ type: 'START_JOB', mode, tabId, overrides: { ...FAST, ...overrides } });
  assert.deepEqual(res, { ok: true }, `START_JOB ${mode} should be accepted`);
  const started = await readJobState();
  assert.equal(started.status, 'running');
  assert.equal(started.mode, mode);
  assert.equal(started.tabId, tabId);
  return waitForJobEnd(started.id, onRunning);
}

async function waitForJobEnd(jobId, onRunning) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  for (;;) {
    const st = await readJobState();
    assert.equal(st?.id, jobId, 'job state should belong to the job we started');
    if (!['running', 'stopping'].includes(st.status)) return st;
    if (onRunning) await onRunning(st);
    if (Date.now() > deadline) throw new Error(`job did not finish in time; last phase: ${st.phase}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Raw IndexedDB read from an extension page (never creates the database). */
async function readDb() {
  return ui.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('fb-comment-saver');
        req.onupgradeneeded = () => req.transaction.abort(); // DB missing: don't create it
        req.onerror = () => resolve({ posts: [], comments: [] });
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['posts', 'comments'], 'readonly');
          const out = {};
          tx.objectStore('posts').getAll().onsuccess = (e) => (out.posts = e.target.result);
          tx.objectStore('comments').getAll().onsuccess = (e) => (out.comments = e.target.result);
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}

async function commentsOf(postId) {
  const { comments } = await readDb();
  return comments.filter((c) => c.postId === postId).sort((a, b) => a.order - b.order);
}

/**
 * Whether this extension still holds a chrome.debugger session on the tab. getTargets() can't tell:
 * it reports `attached: true` before, during and after a job, because Node Playwright's own CDP
 * session counts too. So probe with attach(), which fails only while our extension is attached.
 */
async function ourDebuggerAttached(tabId) {
  return ui.evaluate(async (id) => {
    try {
      await chrome.debugger.attach({ tabId: id }, '1.3');
    } catch (e) {
      return /already attached/i.test(String(e.message)) ? true : `attach failed: ${e.message}`;
    }
    await chrome.debugger.detach({ tabId: id });
    return false;
  }, tabId);
}

/** Minimal RFC 4180 parser (quoted fields may contain commas, quotes and CR/LF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const localIso = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).toISOString();

// ------------------------------------------------------------------------------------------------
// Setup

before(async () => {
  if (!fs.existsSync(path.join(DIST, 'background.js')) || !fs.existsSync(path.join(DIST, 'manifest.json'))) {
    execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, stdio: 'inherit' });
  }
  ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  await ctx.route(`${FB}/**`, serveFixture);

  [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
  sw.on('console', (m) => {
    if (m.type() === 'error') swErrors.push(m.text());
  });

  ui = await ctx.newPage();
  watchErrors(ui, uiErrors, 'sidepanel');
  await ui.goto(`chrome-extension://${extId}/sidepanel.html`);
  await ui.locator('#stat-posts').filter({ hasText: /^\d+$/ }).waitFor({ timeout: 15_000 });

  fb = await ctx.newPage();
  // Close the blank tab a persistent context starts with, so fbTabId() stays unambiguous.
  for (const p of ctx.pages()) if (p !== ui && p !== fb && p.url() === 'about:blank') await p.close();
});

after(async () => {
  await ctx?.close();
});

// ------------------------------------------------------------------------------------------------
// Scenarios (sequential; later ones build on the archive of earlier ones)

/** Snapshot of post 1001 after the first full save (used by scenario b). */
let firstSave1001 = [];

test('a. "post" mode saves every comment and reply of post 1001', TEST_TIMEOUT, async () => {
  // Positive control for ourDebuggerAttached(): true while Playwright is expanding comments.
  let attachedWhileRunning = null;
  const st = await runJob('post', {
    url: postUrl(1001),
    onRunning: async (s) => {
      if (attachedWhileRunning === null && /round \d+/i.test(s.phase || '')) {
        attachedWhileRunning = await ourDebuggerAttached(s.tabId);
      }
    },
  });
  assert.equal(attachedWhileRunning, true, 'the job drives the tab through chrome.debugger');
  assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
  assert.equal(st.postsDone, 1);
  assert.equal(st.postsFailed, 0);
  assert.equal(st.commentsSeen, 17);
  assert.equal(st.inserted, 17);
  assert.equal(st.markedMissing, 0);
  assert.ok(st.log.some((l) => /Sorted comments: All comments/.test(l.msg)), 'sort switched to "All comments"');
  assert.ok(st.log.some((l) => /All comments loaded: 17/.test(l.msg)), 'expansion reported complete');

  const { posts } = await readDb();
  const post = posts.find((p) => p.id === '1001');
  assert.ok(post, 'post 1001 saved');
  assert.equal(post.groupSlug, 'testgroup');
  assert.equal(post.url, postUrl(1001));
  assert.equal(post.authorName, 'Kyaw Zin Thant');
  assert.equal(post.authorId, '100001');
  assert.equal(post.authorUrl, `${FB}/profile.php?id=100001`);
  assert.match(post.text, /^Do you need a CS degree to become a software engineer in Myanmar\? 🤔\n/);
  assert.match(post.text, /Some companies here only hire graduates/, 'post "See more" was expanded');
  assert.match(post.text, /ဘယ်လိုထင်ကြလဲ$/);
  assert.equal(post.postedAtText, '4 October at 18:19');
  assert.ok(post.postedAt, 'postedAt parsed');
  assert.equal(post.commentCountExpected, 12);
  assert.equal(post.lastMode, 'post');
  assert.ok(post.lastFullScanAt, 'complete scan → lastFullScanAt set');
  assert.equal(post.savedCommentCount, 17);

  const comments = await commentsOf('1001');
  assert.deepEqual(comments.map((c) => c.id), FULL_ORDER_1001, 'all 17 comments in thread (pre-)order');
  assert.ok(!comments.some((c) => c.id === '2999'), 'the feed preview comment behind the dialog is ignored');
  const byId = Object.fromEntries(comments.map((c) => [c.id, c]));

  // Thread structure: C1 → R1, R2 → R3 (reply to a reply); C4 → R4, R5.
  const shape = (id) => {
    const c = byId[id];
    return { threadId: c.threadId, parentId: c.parentId, depth: c.depth, isReply: c.isReply };
  };
  assert.deepEqual(shape('2001'), { threadId: '2001', parentId: null, depth: 0, isReply: false });
  assert.deepEqual(shape('3001'), { threadId: '2001', parentId: '2001', depth: 1, isReply: true });
  assert.deepEqual(shape('3002'), { threadId: '2001', parentId: '2001', depth: 1, isReply: true });
  assert.deepEqual(shape('3003'), { threadId: '2001', parentId: '3002', depth: 2, isReply: true });
  assert.deepEqual(shape('3004'), { threadId: '2004', parentId: '2004', depth: 1, isReply: true });
  assert.deepEqual(shape('3005'), { threadId: '2004', parentId: '2004', depth: 1, isReply: true });
  for (const id of ['2002', '2003', '2005', '2006', '2007', '2008', '2009', '2010', '2011', '2012']) {
    assert.deepEqual(shape(id), { threadId: id, parentId: null, depth: 0, isReply: false }, `top-level ${id}`);
  }
  assert.equal(byId['3003'].replyToName, 'Min Thu');
  assert.equal(byId['3003'].replyToKind, 'reply');
  assert.equal(byId['3001'].replyToName, 'Thura Min Oo');
  assert.equal(byId['3001'].replyToKind, 'comment');

  // Authors, text, emoji, Myanmar script.
  const c1 = byId['2001'];
  assert.equal(c1.authorName, 'Thura Min Oo');
  assert.equal(c1.authorId, '100101');
  assert.equal(c1.authorUrl, `${FB}/profile.php?id=100101`);
  assert.equal(
    c1.text,
    'Hardly any degree exists that teaches you everything you need on the job.\n' +
      'Is there truly a degree that covers Kubernetes, React and SQL at the same time?',
  );
  assert.equal(byId['2002'].authorName, 'Chai_lover🍵');
  assert.equal(byId['2002'].text, 'Coding with tea 🍵 is the best 😂');
  assert.equal(byId['3005'].text, 'Is that a matcha 🍵 on the desk?');
  assert.equal(byId['3002'].text, 'ကျွန်တော်လည်း သဘောတူပါတယ်။');

  // "See more" in a comment was expanded; nothing left truncated.
  assert.match(byId['2003'].text, /what matters most is how fast you can learn\.\nBuild projects/);
  assert.ok(comments.every((c) => c.truncated === false), 'no comment left truncated');

  // Reactions, dates, permalinks.
  assert.equal(c1.reactionCount, 5);
  assert.equal(byId['3001'].reactionCount, 1);
  assert.equal(byId['2002'].reactionCount, 0);
  assert.equal(c1.createdAtText, 'Monday 12 October 2026 at 08:54');
  assert.equal(c1.createdAt, localIso(2026, 10, 12, 8, 54));
  assert.equal(c1.createdAtApprox, false);
  assert.equal(c1.relativeTime, '2d');
  assert.equal(c1.permalink, `${postUrl(1001)}?comment_id=2001`);
  assert.equal(byId['3003'].permalink, `${postUrl(1001)}?comment_id=2001&reply_comment_id=3003`);

  // Attachments: image, decoded link-shim target, sticker-only comment.
  const image = byId['2004'].attachments.find((a) => a.type === 'image');
  assert.ok(image, 'C4 has an image attachment');
  assert.match(image.src, /^data:image\/svg\+xml/);
  assert.equal(image.alt, 'May be an image of laptop, desk and coffee cup');
  assert.deepEqual(byId['2007'].attachments, [{ type: 'link', href: 'https://roadmap.sh/' }]);
  assert.equal(byId['2010'].text, '');
  assert.equal(byId['2010'].attachments.length, 1);
  assert.equal(byId['2010'].attachments[0].type, 'image');

  // Bookkeeping fields.
  for (const c of comments) {
    assert.equal(c.postId, '1001');
    assert.equal(c.groupSlug, 'testgroup');
    assert.equal(c.missingAt, null);
    assert.deepEqual(c.previousTexts, []);
    assert.ok(c.firstSavedAt && c.firstSavedAt === c.lastSavedAt);
  }

  // The debugger session is released (no infobar left behind).
  assert.equal(await ourDebuggerAttached(await fbTabId()), false, 'chrome.debugger released after the job');
  firstSave1001 = comments;
});

test('b. a full re-scan marks a vanished comment as missing and keeps the rest', TEST_TIMEOUT, async () => {
  assert.ok(firstSave1001.length, 'scenario a must have run');
  const st = await runJob('post', { url: postUrl(1001, '?variant=minus1') });
  assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
  assert.equal(st.commentsSeen, 16);
  assert.equal(st.inserted, 0);
  assert.equal(st.markedMissing, 1);

  const comments = await commentsOf('1001');
  assert.equal(comments.length, 17, 'nothing is deleted');
  const missing = comments.filter((c) => c.missingAt);
  assert.deepEqual(missing.map((c) => c.id), ['2005']);
  assert.equal(missing[0].authorName, 'Zaw Min Oo');

  const before = Object.fromEntries(firstSave1001.map((c) => [c.id, c]));
  for (const c of comments) {
    assert.equal(c.text, before[c.id].text, `text of ${c.id} unchanged`);
    assert.equal(c.firstSavedAt, before[c.id].firstSavedAt, `firstSavedAt of ${c.id} kept`);
    assert.deepEqual(c.previousTexts, [], `${c.id} not treated as edited`);
    if (c.id !== '2005') {
      assert.equal(c.missingAt, null);
      assert.notEqual(c.lastSavedAt, before[c.id].lastSavedAt, `${c.id} seen again`);
    }
  }
  const { posts } = await readDb();
  const post = posts.find((p) => p.id === '1001');
  assert.equal(post.savedCommentCount, 17);
  assert.ok(post.lastFullScanAt > firstSave1001[0].lastSavedAt, 'lastFullScanAt moved forward');
  assert.equal(await ourDebuggerAttached(await fbTabId()), false);
});

test('b2. closing the post dialog mid-scan saves nothing and marks nothing missing', TEST_TIMEOUT, async () => {
  const before = await readDb();
  const postBefore = before.posts.find((p) => p.id === '1001');
  let closedAt = null;
  const st = await runJob('post', {
    url: postUrl(1001),
    onRunning: async (s) => {
      if (!closedAt && /round 1\b/i.test(s.phase || '')) {
        closedAt = Date.now();
        // Facebook's SPA close (the user clicks Close): the dialog goes, the URL is the group again,
        // and the group feed behind (with a preview of this very post) is all that is left.
        await fb.evaluate(() => document.querySelector('[role="dialog"] [aria-label="Close"]').click());
      }
    },
  });
  assert.ok(closedAt, 'the dialog was closed while the job ran');
  assert.equal(st.status, 'error', `job should fail (log: ${st.log.map((l) => l.msg).join(' | ')})`);
  assert.match(st.error, /closed or the tab navigated away/);
  assert.equal(st.commentsSeen, 0);
  assert.equal(st.markedMissing, 0);
  assert.ok(!st.log.some((l) => /Saved post/.test(l.msg)), 'nothing saved');

  const after = await readDb();
  const postAfter = after.posts.find((p) => p.id === '1001');
  assert.equal(postAfter.lastFullScanAt, postBefore.lastFullScanAt, 'no new full scan recorded');
  assert.equal(postAfter.lastSavedAt, postBefore.lastSavedAt);
  assert.deepEqual(
    (await commentsOf('1001')).filter((c) => c.missingAt).map((c) => c.id),
    ['2005'],
    'only the comment found missing in scenario b',
  );
  assert.equal(after.comments.length, before.comments.length, 'the feed preview behind was not saved');
  assert.equal(await ourDebuggerAttached(await fbTabId()), false);
  // The failure was logged by the job runner on purpose (Chromium also echoes the service worker's
  // console to the extension's open pages).
  await new Promise((r) => setTimeout(r, 500)); // let the console events arrive
  for (const sink of [swErrors, uiErrors]) {
    for (let i = sink.length - 1; i >= 0; i--) if (/closed or the tab navigated away/.test(sink[i])) sink.splice(i, 1);
  }
});

test('c. "quick" mode saves only the comments already visible, without the debugger', TEST_TIMEOUT, async () => {
  const st = await runJob('quick', { url: postUrl(1002) });
  assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
  assert.equal(st.inserted, 5);
  assert.ok(!st.log.some((l) => /Attached to the tab/.test(l.msg)), 'quick save does not attach the debugger');

  const comments = await commentsOf('1002');
  assert.deepEqual(
    comments.map((c) => c.id),
    ['100202001', '100202002', '100202003', '100202004', '100202005'],
  );
  const c3 = comments.find((c) => c.id === '100202003');
  assert.equal(c3.truncated, true, '"See more" is not clicked in quick mode');
  assert.match(c3.text, /^When I started my career/);

  const { posts } = await readDb();
  const post = posts.find((p) => p.id === '1002');
  assert.equal(post.lastMode, 'quick');
  assert.equal(post.lastFullScanAt, null);
  assert.equal(post.savedCommentCount, 5);
  assert.equal(await ourDebuggerAttached(await fbTabId()), false);
});

test('d. "crawl" mode collects posts from the feed, saves each fully and returns to the group', TEST_TIMEOUT, async () => {
  const st = await runJob('crawl', {
    url: `${GROUP_URL}/`,
    overrides: { maxPosts: 4, groupUrl: GROUP_URL, feedSort: 'DEFAULT' },
  });
  assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
  assert.equal(st.postsTotal, 4);
  assert.equal(st.postsDone, 4);
  assert.equal(st.postsFailed, 0);
  assert.equal(st.commentsSeen, 4 * 17);

  const { posts } = await readDb();
  for (const id of ['1001', '1002', '1003', '1004']) {
    const post = posts.find((p) => p.id === id);
    assert.ok(post, `post ${id} saved`);
    assert.equal(post.lastMode, 'crawl');
    assert.ok(post.lastFullScanAt, `post ${id} fully scanned`);
    assert.equal(post.savedCommentCount, 17, `post ${id} has 17 comments`);
    assert.equal(post.url, postUrl(id));
  }

  // 1001: the comment marked missing in scenario b is back.
  assert.ok((await commentsOf('1001')).every((c) => c.missingAt === null), 'C5 of 1001 found again');
  // 1002: the quick-saved truncated text was completed, not recorded as an edit.
  const c3 = (await commentsOf('1002')).find((c) => c.id === '100202003');
  assert.equal(c3.truncated, false);
  assert.match(c3.text, /how fast you can learn\.\nBuild projects/);
  assert.deepEqual(c3.previousTexts, []);
  // Thread structure on another post, with prefixed ids.
  const r3 = (await commentsOf('1003')).find((c) => c.id === '100303003');
  assert.deepEqual(
    { threadId: r3.threadId, parentId: r3.parentId, depth: r3.depth },
    { threadId: '100302001', parentId: '100303002', depth: 2 },
  );

  assert.match(fb.url(), /^https:\/\/www\.facebook\.com\/groups\/testgroup\/?$/, 'tab is back on the group feed');
  assert.equal(await ourDebuggerAttached(await fbTabId()), false);
});

test('d2. a crawl started on another group page (Members) opens the group feed first', TEST_TIMEOUT, async () => {
  // classifyTabUrl calls /groups/<slug>/members a "group" page, but it has no feed (404 here).
  const st = await runJob('crawl', {
    url: `${GROUP_URL}/members`,
    overrides: { maxPosts: 2, groupUrl: GROUP_URL, feedSort: 'DEFAULT', skipSavedWithinHours: 0 },
  });
  assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
  assert.ok(st.log.some((l) => /Opening the group feed/.test(l.msg)), 'navigated to the feed');
  assert.equal(st.postsTotal, 2);
  assert.equal(st.postsDone, 2);
  assert.equal(st.postsFailed, 0);
  assert.match(fb.url(), /^https:\/\/www\.facebook\.com\/groups\/testgroup\/?$/);
});

test('e. a post without comments is saved as complete with 0 comments', TEST_TIMEOUT, async () => {
  const st = await runJob('post', { url: postUrl(9999) });
  assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
  assert.equal(st.commentsSeen, 0);
  assert.ok(st.log.some((l) => /no comments yet/i.test(l.msg)));

  const { posts } = await readDb();
  const post = posts.find((p) => p.id === '9999');
  assert.ok(post, 'post 9999 saved');
  assert.equal(post.authorName, 'Aung Ko Ko');
  assert.equal(post.savedCommentCount, 0);
  assert.equal(post.commentCountExpected, null);
  assert.ok(post.lastFullScanAt, 'empty post counts as fully scanned');
  assert.equal((await commentsOf('9999')).length, 0);
  assert.equal(await ourDebuggerAttached(await fbTabId()), false);
});

test('f. STOP_JOB during a crawl stops quickly and releases the debugger', TEST_TIMEOUT, async () => {
  let stopSentAt = 0;
  const st = await runJob('crawl', {
    url: `${GROUP_URL}/`,
    overrides: { maxPosts: 10, groupUrl: GROUP_URL, feedSort: 'DEFAULT' },
    onRunning: async (s) => {
      // Stop while a post is being expanded.
      if (!stopSentAt && /^Post \d+\/\d+: /.test(s.phase || '')) {
        stopSentAt = Date.now();
        assert.deepEqual(await send({ type: 'STOP_JOB' }), { ok: true });
      }
    },
  });
  assert.ok(stopSentAt, 'the crawl reached the post phase');
  assert.equal(st.status, 'stopped', `job should be stopped (error: ${st.error})`);
  assert.ok(Date.now() - stopSentAt < 15_000, 'stopped within 15 s');
  assert.ok(st.postsDone < 10, 'did not finish the crawl');
  assert.equal(st.error, null);
  assert.equal(await ourDebuggerAttached(await fbTabId()), false, 'debugger released after stop');

  // A new job can start right away (the runner is idle again). This quick save sees only the 5
  // initially visible comments of the fully scanned post 1001; it must not renumber the thread.
  const again = await runJob('quick', { url: postUrl(1001) });
  assert.equal(again.status, 'done', `job should finish (error: ${again.error})`);
  assert.equal(again.commentsSeen, 5);
  assert.deepEqual((await commentsOf('1001')).map((c) => c.id), FULL_ORDER_1001, 'thread order kept');
});

test('g. UI smoke: side panel and library render the archive; CSV export downloads', TEST_TIMEOUT, async () => {
  const { posts, comments } = await readDb();
  assert.ok(posts.length >= 5);

  // Side panel: stats follow the archive (DB_CHANGED / storage events).
  await ui.locator('#stat-posts').filter({ hasText: new RegExp(`^${posts.length}$`) }).waitFor({ timeout: 10_000 });
  assert.equal(await ui.locator('#stat-comments').innerText(), comments.length.toLocaleString('en-US'));
  assert.equal(await ui.locator('#progress-card').isVisible(), true, 'last job is shown');

  const libErrors = [];
  const lib = await ctx.newPage();
  watchErrors(lib, libErrors, 'library');
  await lib.goto(`chrome-extension://${extId}/library.html`);
  await lib.locator('.post-item').first().waitFor({ timeout: 15_000 });
  assert.equal(await lib.locator('.post-item').count(), posts.length, 'every saved post is listed');

  // Select post 1001 → threaded comments.
  await lib.locator('.post-item[data-id="1001"]').click();
  await lib.locator('#detail .comment').nth(16).waitFor({ timeout: 10_000 });
  assert.equal(await lib.locator('#detail .comment').count(), 17);
  const nesting = (id) =>
    lib.locator(`#c-${id}`).evaluate((node) => {
      let n = 0;
      for (let p = node.parentElement; p; p = p.parentElement) if (p.matches('ol.thread-replies')) n++;
      return n;
    });
  assert.equal(await nesting('2001'), 0);
  assert.equal(await nesting('3002'), 1);
  assert.equal(await nesting('3003'), 2, 'reply-to-reply nested two levels deep');
  assert.match(await lib.locator('#c-2002').innerText(), /Chai_lover🍵/);
  assert.match(await lib.locator('#c-3002').innerText(), /ကျွန်တော်လည်း/);

  // Search across comments.
  await lib.locator('#search').fill('roadmap');
  await lib.locator('.result').first().waitFor({ timeout: 10_000 });
  assert.ok((await lib.locator('.result').count()) >= 1);

  // Global CSV export.
  const [download] = await Promise.all([
    lib.waitForEvent('download', { timeout: 15_000 }),
    lib.locator('[data-export-all="csv"]').click(),
  ]);
  assert.match(download.suggestedFilename(), /^fb-comments-all-\d{8}-\d{4}\.csv$/);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.equal(csv.charCodeAt(0), 0xfeff, 'CSV starts with a UTF-8 BOM');
  const rows = parseCsv(csv.slice(1));
  assert.equal(rows[0][0], 'post_id');
  assert.equal(rows.length, 1 + comments.length, 'one row per saved comment plus the header');
  assert.ok(rows.every((r) => r.length === rows[0].length), 'every row has every column');
  assert.ok(rows.some((r) => r[11] === 'Chai_lover🍵'), 'emoji survive the export');

  assert.deepEqual(libErrors, [], 'library page has no errors');
  assert.deepEqual(uiErrors, [], 'side panel page has no errors');
  await lib.close();
});

test('h. the side panel follows the active tab of its own window, not the last focused window', TEST_TIMEOUT, async () => {
  await fb.goto(postUrl(1002), { waitUntil: 'load' });
  await fb.bringToFront();
  const chip = ui.locator('#tab-chip-label');
  await chip.filter({ hasText: /^Post$/ }).waitFor({ timeout: 10_000 });

  // Another window gets focus (a library tab there): the panel must keep showing its own window's tab.
  const otherWindow = await ui.evaluate(async (url) => (await chrome.windows.create({ url, focused: true })).id, `chrome-extension://${extId}/library.html`);
  try {
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await chip.innerText(), 'Post');
    assert.equal(await ui.locator('#btn-quick-save').isDisabled(), false);

    // Starting from the panel works on that tab.
    const previousJob = (await readJobState())?.id;
    await ui.locator('#btn-quick-save').click();
    let st = await readJobState();
    for (let i = 0; i < 60 && (st?.id === previousJob || ['running', 'stopping'].includes(st?.status)); i++) {
      await new Promise((r) => setTimeout(r, 250));
      st = await readJobState();
    }
    assert.notEqual(st.id, previousJob, 'a new job was started from the panel');
    assert.equal(st.mode, 'quick');
    assert.equal(st.status, 'done', `quick save should finish (error: ${st.error})`);
    assert.equal(st.tabId, await fbTabId(), 'the job ran on the tab the panel showed');
  } finally {
    await ui.evaluate((id) => chrome.windows.remove(id), otherWindow);
  }
});

test('i. library: long reply chains nest at most two levels; a deep link leaves search results', TEST_TIMEOUT, async () => {
  // A back-and-forth: every reply answers the previous one (parentId chain, depth capped at 2).
  // "early" is a reply stored with an order before its parent's (a partial save).
  const now = new Date().toISOString();
  const c = (id, order, extra = {}) => ({
    id, postId: 'chain1', groupSlug: 'testgroup', threadId: 'T', parentId: null, depth: 0, isReply: false,
    replyToName: null, replyToKind: null, authorName: `Author ${id}`, authorId: null, authorUrl: null,
    text: `text of ${id}`, truncated: false, createdAt: now, createdAtApprox: false, createdAtText: null,
    relativeTime: null, reactionCount: 0, attachments: [], permalink: null, order, firstSavedAt: now,
    lastSavedAt: now, missingAt: null, previousTexts: [], ...extra,
  });
  const comments = [c('T', 0)];
  for (let i = 1; i <= 8; i++) {
    comments.push(c(`r${i}`, i, { isReply: true, depth: Math.min(i, 2), parentId: i === 1 ? 'T' : `r${i - 1}`, replyToName: `Author ${i === 1 ? 'T' : `r${i - 1}`}`, replyToKind: i === 1 ? 'comment' : 'reply' }));
  }
  comments.push(c('early', -1, { isReply: true, depth: 1, parentId: 'T', replyToName: 'Author T', replyToKind: 'comment' }));
  const post = {
    id: 'chain1', groupSlug: 'testgroup', url: postUrl('chain1'), authorName: 'Chain Author', authorId: null, authorUrl: null,
    text: 'A long argument', postedAt: now, postedAtApprox: false, postedAtText: null, commentCountExpected: null,
    lastMode: 'post', firstSavedAt: now, lastSavedAt: now, lastFullScanAt: now, savedCommentCount: comments.length,
  };
  await ui.evaluate(
    ({ post, comments }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('fb-comment-saver');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['posts', 'comments'], 'readwrite');
          tx.objectStore('posts').put(post);
          for (const cm of comments) tx.objectStore('comments').put(cm);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { post, comments },
  );

  const libErrors = [];
  const lib = await ctx.newPage();
  watchErrors(lib, libErrors, 'library');
  try {
    await lib.goto(`chrome-extension://${extId}/library.html#post=chain1`);
    await lib.locator('#detail .comment').nth(comments.length - 1).waitFor({ timeout: 10_000 });
    assert.equal(await lib.locator('#detail .comment').count(), comments.length);
    const nesting = (id) =>
      lib.locator(`#c-${id}`).evaluate((node) => {
        let n = 0;
        for (let p = node.parentElement; p; p = p.parentElement) if (p.matches('ol.thread-replies')) n++;
        return n;
      });
    assert.equal(await nesting('T'), 0);
    assert.equal(await nesting('r1'), 1);
    for (let i = 2; i <= 8; i++) assert.equal(await nesting(`r${i}`), 2, `r${i} is listed at level 2`);
    assert.equal(await nesting('early'), 1, 'a reply ordered before its parent is still nested under it');
    assert.equal(await lib.locator('.comment.is-orphan').count(), 0);
    assert.match(await lib.locator('#c-r8').innerText(), /replying to Author r7/);
    const left = (id) => lib.locator(`#c-${id}`).evaluate((n) => Math.round(n.getBoundingClientRect().left));
    const [l0, l2, l8] = [await left('T'), await left('r2'), await left('r8')];
    assert.equal(l8, l2, 'deeper replies are not indented further');
    assert.ok(l8 - l0 <= 80, `two indentation levels at most (${l8 - l0}px)`);

    // Search, then the side panel's "View" deep link to the same post (openLibrary adds a nonce).
    await lib.locator('#search').fill('text of r3');
    await lib.locator('#detail[data-view="search"] .result').first().waitFor({ timeout: 10_000 });
    const libUrl = `chrome-extension://${extId}/library.html`;
    await ui.evaluate(async ({ libUrl, target }) => {
      const [tab] = await chrome.tabs.query({ url: `${libUrl}*` });
      await chrome.tabs.update(tab.id, { url: target });
    }, { libUrl, target: `${libUrl}#post=chain1&t=${Date.now()}` });
    await lib.locator('#detail[data-view="post"]').waitFor({ timeout: 10_000 });
    assert.equal(await lib.locator('#search').inputValue(), '', 'search left');
    await lib.waitForFunction(() => location.hash === '#post=chain1', null, { timeout: 5000 });
    assert.deepEqual(libErrors, []);
  } finally {
    await lib.close();
  }
});

/** Author names and text snippets the fixtures show (must never appear in diagnostics). */
const FIXTURE_NAMES = [
  'Kyaw Zin Thant', 'Thura Min Oo', 'Aye Chan Moe', 'Chai_lover', 'Min Thu', 'Su Su Hlaing', 'Ei Mon Kyaw',
  'Zaw Min Oo', 'LuckyPanda7781', 'Feed Preview Person', 'Aung Ko Ko', 'testgroup',
];

test('j. markup without hrefs (?variant=nohref): the crawl finds posts and comment ids from React data', TEST_TIMEOUT, async () => {
  fixtureVariant = 'nohref';
  try {
    const st = await runJob('crawl', {
      url: `${GROUP_URL}/?variant=nohref`,
      overrides: { maxPosts: 3, groupUrl: GROUP_URL, feedSort: 'DEFAULT', skipSavedWithinHours: 0 },
    });
    assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
    assert.equal(st.postsTotal, 3);
    assert.equal(st.postsFailed, 0);
    assert.equal(st.commentsSeen, 3 * 17);
    assert.ok(st.log.some((l) => /^Feed scan: \d+ posts seen — ids from links 0, page data [1-9]/.test(l.msg)), 'ids from page data');
    // The same posts were saved earlier with permalinks: React ids match them exactly.
    assert.equal(st.inserted, 0, 'no new (synthetic) comments');
    assert.equal(st.markedMissing, 0, 'nothing marked missing');
    for (const id of ['1001', '1002', '1003']) {
      const comments = await commentsOf(id);
      assert.ok(comments.length >= 17, `post ${id} comments`);
      assert.ok(comments.every((c) => !c.id.startsWith('h:')), `post ${id} has only real comment ids`);
    }
    assert.deepEqual((await commentsOf('1001')).map((c) => c.id), FULL_ORDER_1001);
  } finally {
    fixtureVariant = '';
  }
});

test('k. quick save reads React data in the MAIN world (?variant=nohref post)', TEST_TIMEOUT, async () => {
  fixtureVariant = 'nohref';
  try {
    const st = await runJob('quick', { url: postUrl(1005, '?variant=nohref') });
    assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
    assert.equal(st.inserted, 5);
    const comments = await commentsOf('1005');
    assert.deepEqual(
      comments.map((c) => c.id),
      ['100502001', '100502002', '100502003', '100502004', '100502005'],
      'comment ids from React data (an isolated world would only get synthetic ids)',
    );
    assert.equal(comments[0].authorId, '100101');
    assert.equal(comments[0].permalink, `${GROUP_URL}/posts/1005/?comment_id=100502001`);
    assert.ok(!st.log.some((l) => /synthetic/.test(l.msg)));
  } finally {
    fixtureVariant = '';
  }
});

test('l. side panel "Copy diagnostics": a privacy-safe report of the page and the last job', TEST_TIMEOUT, async () => {
  fixtureVariant = 'nohref';
  try {
    await fb.goto(postUrl(1005, '?variant=nohref'), { waitUntil: 'load' });
    await fb.bringToFront();
    await ui.locator('#tab-chip-label').filter({ hasText: /^Post$/ }).waitFor({ timeout: 10_000 });
    // The last job (quick save, 5 comments) saved something: no diagnostics offer in its card.
    assert.equal(await ui.locator('#btn-diag-job').isHidden(), true);

    // Clipboard available: the report is copied and a toast confirms it.
    await ui.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (t) => void (window.__copied = t) },
      });
    });
    const settings = ui.locator('#settings');
    if (!(await settings.evaluate((d) => d.open))) await ui.locator('#settings > summary').click();
    await ui.locator('#btn-diag').click();
    await ui.locator('.toast', { hasText: 'Diagnostics copied — paste it in your message' }).waitFor({ timeout: 10_000 });
    const text = await ui.evaluate(() => window.__copied);
    const report = JSON.parse(text);
    assert.match(report.extension, /^\d+\.\d+\.\d+$/);
    assert.equal(report.page.rootKind, 'dialog');
    assert.equal(report.page.dialog.post.comments.count, 5);
    assert.equal(report.page.dialog.post.comments.withFiberId, 5, 'MAIN world: React data is visible');
    assert.equal(report.lastJob.mode, 'quick');
    assert.ok(report.lastJob.log.length > 0 && report.lastJob.log.length <= 40);
    for (const name of FIXTURE_NAMES) assert.ok(!text.includes(name), `report contains "${name}"`);
    assert.doesNotMatch(text, /\d{5,}/, 'no ids in the report');
    assert.doesNotMatch(text, /https?:\/\//, 'no URLs in the report');

    // Clipboard refused: the report is shown in a read-only text box with "Select all".
    await ui.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new Error('denied'); } },
      });
    });
    await ui.locator('#btn-diag').click();
    const area = ui.locator('.diag-fallback textarea');
    await area.waitFor({ timeout: 10_000 });
    assert.equal(await area.getAttribute('readonly'), '');
    const fallback = JSON.parse(await area.inputValue());
    assert.equal(fallback.page.rootKind, 'dialog');
    await ui.locator('.diag-fallback button', { hasText: 'Select all' }).click();
    await ui.locator('.diag-fallback button', { hasText: 'Close' }).click();
    assert.equal(await ui.locator('.diag-fallback').count(), 0);
  } finally {
    fixtureVariant = '';
  }
});

test('m. posts with an aria-label and lazy "#" links (?variant=arialabel,nohref,hash): the crawl saves them fully', TEST_TIMEOUT, async () => {
  // Friend-like markup: post articles carry an aria-label like comments, and every link Facebook has
  // not filled in is href="#" (a.href resolves it to the page URL). Posts must still be found in the
  // feed and as the dialog root, and comment ids must come from React data, not from "#".
  fixtureVariant = 'arialabel,nohref,hash';
  try {
    const startedAt = new Date().toISOString();
    const st = await runJob('crawl', {
      url: `${GROUP_URL}/?variant=${fixtureVariant}`,
      overrides: { maxPosts: 2, groupUrl: GROUP_URL, feedSort: 'DEFAULT', skipSavedWithinHours: 0 },
    });
    assert.equal(st.status, 'done', `job should finish (error: ${st.error})`);
    assert.equal(st.postsTotal, 2);
    assert.equal(st.postsFailed, 0, st.log.map((l) => l.msg).join('\n'));
    assert.equal(st.commentsSeen, 2 * 17);
    assert.equal(st.inserted, 0, 'the same comment ids as the earlier saves (no synthetic or "#" ids)');
    assert.equal(st.markedMissing, 0);
    const saved = st.log.filter((l) => /^Saved post \d+:/.test(l.msg));
    assert.equal(saved.length, 2);
    assert.ok(saved.every((l) => !/incomplete scan/.test(l.msg)), saved.map((l) => l.msg).join('\n'));
    assert.deepEqual((await commentsOf('1001')).map((c) => c.id), FULL_ORDER_1001);
    assert.deepEqual((await commentsOf('1002')).map((c) => c.id), FULL_ORDER_1001.map((id) => `10020${id}`));
    const { posts } = await readDb();
    for (const id of ['1001', '1002']) {
      const post = posts.find((p) => p.id === id);
      assert.ok(post.lastFullScanAt >= startedAt, `post ${id} fully scanned by this crawl`);
      assert.equal(post.authorName, 'Kyaw Zin Thant', 'the stored author is kept (the lazy header gives none)');
    }
  } finally {
    fixtureVariant = '';
  }
});

test('the service worker logged no unexpected errors', () => {
  // Job errors are logged with console.error by design; none of the scenarios above should fail.
  assert.deepEqual(swErrors, []);
});
