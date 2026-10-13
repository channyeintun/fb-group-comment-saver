// Browser tests for the Playwright driver (src/background/pw-driver.js): the real waitForPostRoot /
// preparePost run in Node against the synthetic Facebook fixtures in headless Chromium.
//
// pw-driver.js imports playwright-crx, which only runs inside the extension. Everything else it
// uses is the Playwright Page API, which Node's playwright provides as well, so the module is
// bundled here with esbuild and `playwright-crx` replaced by an empty stub (withPage is not used).
//
// The fixtures' timing variants (?dialogDelay, ?feedbackDelay, ?loadMs, ?keepLabel, ?duds) reproduce
// what was observed on the live site or on slow connections; see tests/fixtures/post-dialog.html.
//
// Run: node --test "tests/browser/*.test.mjs"

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

import { compilePatterns, sanitizeSettings } from '../../src/lib/settings.js';
import { extractRaw } from '../../src/page/extract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'tests/fixtures');
const ORIGIN = 'https://www.facebook.com';
const postUrl = (id, query = '') => `${ORIGIN}/groups/testgroup/posts/${id}/${query}`;
const FULL_ORDER = ['2001', '3001', '3002', '3003', '2002', '2011', '2003', '2004', '3004', '3005', '2005', '2012', '2006', '2007', '2008', '2009', '2010'];

/** @type {typeof import('../../src/background/pw-driver.js')} */
let driver;
let browser;
let bundleDir;

before(async () => {
  const out = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/background/pw-driver.js'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    // Page functions are serialized with fn.toString(): never minify (SPEC §2).
    minify: false,
    keepNames: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'stub-playwright-crx',
        setup(b) {
          b.onResolve({ filter: /^playwright-crx$/ }, () => ({ path: 'playwright-crx', namespace: 'stub' }));
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const crx = {};', loader: 'js' }));
        },
      },
    ],
  });
  bundleDir = await mkdtemp(path.join(tmpdir(), 'fbcs-driver-'));
  const file = path.join(bundleDir, 'pw-driver.mjs');
  await writeFile(file, out.outputFiles[0].text);
  driver = await import(pathToFileURL(file).href);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

const fixtureCache = new Map();
async function fixtureHtml(name) {
  if (!fixtureCache.has(name)) fixtureCache.set(name, await readFile(path.join(FIXTURES, name), 'utf8'));
  return fixtureCache.get(name);
}

async function openPage(url, extraRoutes = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (extraRoutes[pathname]) return route.fulfill({ status: 200, contentType: 'text/html', body: extraRoutes[pathname] });
    let name = null;
    if (/^\/groups\/testgroup\/posts\/9999\/?$/.test(pathname)) name = 'post-empty.html';
    else if (/^\/groups\/testgroup\/(posts|permalink)\/[\w.-]+\/?$/.test(pathname)) name = 'post-dialog.html';
    else if (/^\/groups\/testgroup\/?$/.test(pathname)) name = 'feed.html';
    if (!name) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await fixtureHtml(name) });
  });
  if (url) await page.goto(url);
  return page;
}

/** Driver context like job-runner's, with fast pacing and a log sink. */
function makeCtx(overrides = {}, onLog = null) {
  const settings = sanitizeSettings({ actionDelayMs: 100, postTimeoutSec: 120, ...overrides });
  const logs = [];
  return {
    settings,
    patterns: compilePatterns(settings),
    signal: new AbortController().signal,
    log: (level, msg) => {
      logs.push({ level, msg });
      onLog?.(msg);
    },
    progress: () => {},
    logs,
  };
}

const commentIds = (raw) =>
  raw.posts[0].items.map((c) => {
    const u = new URL(c.permalinkHref);
    return u.searchParams.get('reply_comment_id') || u.searchParams.get('comment_id');
  });

async function expectFullyExpanded(page, result, ctx) {
  assert.equal(result.complete, true, `incomplete: ${result.reason}\n${ctx.logs.map((l) => l.msg).join('\n')}`);
  assert.equal(result.rootKind, 'dialog');
  assert.equal(result.commentCount, 17);
  const raw = await page.evaluate(extractRaw, { scope: 'auto' });
  assert.equal(raw.rootKind, 'dialog');
  assert.deepEqual(commentIds(raw), FULL_ORDER);
  assert.equal(await page.locator('#sort-label').innerText(), 'All comments');
  assert.equal(await page.locator('[role="dialog"] [role="progressbar"]').count(), 0, 'nothing left loading');
}

// ------------------------------------------------------------------------------------------------

test('waitForPostRoot waits for a late dialog instead of taking the feed behind it', async () => {
  // Live: a post URL loaded directly shows the home feed in [role=main] until its dialog mounts.
  const page = await openPage(postUrl(1001, '?dialogDelay=3000'));
  try {
    const t0 = Date.now();
    const kind = await driver.waitForPostRoot(page, { timeoutMs: 15000 });
    assert.equal(kind, 'dialog');
    assert.ok(Date.now() - t0 >= 2000, 'it waited for the dialog');

    const ctx = makeCtx();
    await expectFullyExpanded(page, await driver.preparePost(page, ctx), ctx);
    assert.equal((await page.evaluate(extractRaw, { scope: 'auto' })).posts[0].items.some((c) => /Feed Preview/.test(c.ariaLabel)), false);
  } finally {
    await page.close();
  }
});

test('waitForPostRoot accepts a single-post [role=main] at once when it names the URL\'s post', async () => {
  const html = `<!doctype html><html><body><div role="main"><div role="article" aria-labelledby="p">
    <a href="${ORIGIN}/groups/testgroup/user/1/"><span>Author</span></a>
    <div data-ad-rendering-role="story_message"><div dir="auto">Permalink layout</div></div>
    <div role="article" aria-label="Comment by Ko Ko 1h"><a href="${ORIGIN}/groups/testgroup/user/2/"><span dir="auto">Ko Ko</span></a>
      <a href="${ORIGIN}/groups/testgroup/posts/777/?comment_id=91"><span>1h</span></a><span dir="auto"><div dir="auto">hi</div></span></div>
  </div></div></body></html>`;
  const page = await openPage(`${ORIGIN}/groups/testgroup/permalink/777/`, { '/groups/testgroup/permalink/777/': html });
  try {
    const t0 = Date.now();
    assert.equal(await driver.waitForPostRoot(page, { timeoutMs: 15000 }), 'main');
    assert.ok(Date.now() - t0 < 3000, 'no grace period needed');
  } finally {
    await page.close();
  }
});

test('preparePost continues in the dialog when a [role=main] post turns into a dialog', async () => {
  const comment = (cid, name) =>
    `<div role="article" aria-label="Comment by ${name} 1h"><a href="${ORIGIN}/groups/testgroup/user/${cid}/"><span dir="auto">${name}</span></a>` +
    `<a href="${ORIGIN}/groups/testgroup/posts/778/?comment_id=${cid}"><span>1h</span></a><span dir="auto"><div dir="auto">c${cid}</div></span></div>`;
  const post = (comments) =>
    `<div role="article" aria-labelledby="p"><a href="${ORIGIN}/groups/testgroup/user/1/"><span>Author</span></a>` +
    `<div data-ad-rendering-role="story_message"><div dir="auto">Post</div></div>` +
    `<div role="button" aria-label="Leave a comment"><span></span></div>${comments}</div>`;
  const html = `<!doctype html><html><body><div role="main">${post(comment(91, 'Ko Ko'))}</div>
    <script>window.openDialog = function () {
      var d = document.createElement('div');
      d.setAttribute('role', 'dialog');
      d.innerHTML = ${JSON.stringify(post(comment(91, 'Ko Ko') + comment(92, 'Aye Aye')))};
      document.body.appendChild(d);
    };</script></body></html>`;
  const page = await openPage(`${ORIGIN}/groups/testgroup/permalink/778/`, { '/groups/testgroup/permalink/778/': html });
  try {
    // The dialog mounts while the first round runs on [role=main].
    const ctx = makeCtx({}, (msg) => {
      if (/^Round 1:/.test(msg)) page.evaluate(() => window.openDialog()).catch(() => {});
    });
    const result = await driver.preparePost(page, ctx);
    assert.equal(result.rootKind, 'dialog');
    assert.equal(result.commentCount, 2);
    assert.equal(result.complete, true, result.reason);
    assert.ok(ctx.logs.some((l) => /opened as a dialog/.test(l.msg)));
  } finally {
    await page.close();
  }
});

test('preparePost waits for a late comment area and still switches to "All comments"', async () => {
  // The post body renders first; the counts row and sort control come 2.5 s later.
  const page = await openPage(postUrl(1001, '?feedbackDelay=2500'));
  try {
    assert.equal(await driver.waitForPostRoot(page, { timeoutMs: 15000 }), 'dialog');
    const ctx = makeCtx();
    const result = await driver.preparePost(page, ctx);
    await expectFullyExpanded(page, result, ctx);
    assert.ok(ctx.logs.some((l) => /Sorted comments: All comments/.test(l.msg)));
  } finally {
    await page.close();
  }
});

test('preparePost waits for slow loads (visible spinners) before calling the post complete', async () => {
  // Every loader takes 1.5 s, far longer than the 100 ms action delay.
  const page = await openPage(postUrl(1001, '?loadMs=1500'));
  try {
    await driver.waitForPostRoot(page, { timeoutMs: 15000 });
    const ctx = makeCtx();
    await expectFullyExpanded(page, await driver.preparePost(page, ctx), ctx);
  } finally {
    await page.close();
  }
});

test('expanders that keep their label while loading are not taken for unresponsive ones', async () => {
  const page = await openPage(postUrl(1001, '?keepLabel=1&loadMs=1200'));
  try {
    await driver.waitForPostRoot(page, { timeoutMs: 15000 });
    const ctx = makeCtx();
    await expectFullyExpanded(page, await driver.preparePost(page, ctx), ctx);
    assert.ok(!ctx.logs.some((l) => /unresponsive/.test(l.msg)), ctx.logs.map((l) => l.msg).join('\n'));
  } finally {
    await page.close();
  }
});

test('an unresponsive "View 1 reply" in some threads does not block the same label in others', async () => {
  // Three threads show "View 1 reply" for replies that no longer exist; loads are slow and buttons
  // keep their label while loading. The nested "View 1 reply" under R2 (revealed later) must still
  // be clicked; the post is then reported incomplete.
  const page = await openPage(postUrl(1001, '?duds=3&keepLabel=1&loadMs=1500'));
  try {
    await driver.waitForPostRoot(page, { timeoutMs: 15000 });
    const ctx = makeCtx();
    const result = await driver.preparePost(page, ctx);
    assert.equal(result.complete, false);
    assert.match(result.reason, /3 expander\(s\) did not respond/);
    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.deepEqual(commentIds(raw), FULL_ORDER, 'every real comment and reply loaded, incl. reply-to-reply 3003');
  } finally {
    await page.close();
  }
});

test('preparePost stops when the post dialog is closed mid-scan (never expands the page behind)', async () => {
  const page = await openPage(postUrl(1001));
  try {
    await driver.waitForPostRoot(page, { timeoutMs: 15000 });
    let closed = false;
    const ctx = makeCtx({}, (msg) => {
      if (!closed && /^Round 1:/.test(msg)) {
        closed = true;
        // Facebook's SPA close: the dialog goes away and the URL returns to the group feed.
        page.evaluate(() => document.querySelector('[role="dialog"] [aria-label="Close"]').click()).catch(() => {});
      }
    });
    await assert.rejects(driver.preparePost(page, ctx), (err) => {
      assert.equal(err.message, driver.POST_CLOSED_MSG);
      return true;
    });
    assert.ok(closed, 'the dialog was closed during the scan');
    assert.equal(new URL(page.url()).pathname, '/groups/testgroup/');
    assert.ok(!ctx.logs.some((l) => /All comments loaded/.test(l.msg)));
  } finally {
    await page.close();
  }
});
