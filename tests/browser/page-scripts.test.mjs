// Browser tests for the page scripts (SPEC §4): extractRaw, collectFeedPosts and probePage run
// against the synthetic Facebook fixtures in headless Chromium. The fixtures are served under
// https://www.facebook.com/groups/testgroup/… with page.route, and the page is driven with plain
// Playwright the way src/background/pw-driver.js does (sort → All comments, expanders, wheel
// scrolling, "See more").
//
// Run: node --test "tests/browser/*.test.mjs"

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

import { extractRaw } from '../../src/page/extract.js';
import { collectFeedPosts } from '../../src/page/feed.js';
import { probePage } from '../../src/page/probe.js';
import { DEFAULT_SETTINGS } from '../../src/lib/constants.js';
import { normalizeExtraction } from '../../src/lib/normalize.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const ORIGIN = 'https://www.facebook.com';
const FEED_URL = `${ORIGIN}/groups/testgroup/`;
const postUrl = (id, query = '') => `${ORIGIN}/groups/testgroup/posts/${id}/${query}`;
const ROOT_SEL = '[role="dialog"]:has([role="article"]:not([aria-label]))';

const PATTERNS = {
  expander: new RegExp(DEFAULT_SETTINGS.expanderPattern, 'i'),
  seeMore: new RegExp(DEFAULT_SETTINGS.seeMorePattern, 'i'),
  sortButton: new RegExp(DEFAULT_SETTINGS.sortButtonPattern, 'i'),
  sortAllItem: new RegExp(DEFAULT_SETTINGS.sortAllItemPattern, 'i'),
};
const PROBE_OPTS = {
  expanderPattern: DEFAULT_SETTINGS.expanderPattern,
  seeMorePattern: DEFAULT_SETTINGS.seeMorePattern,
  sortButtonPattern: DEFAULT_SETTINGS.sortButtonPattern,
};

// Fully expanded post 1001 in DOM pre-order (see the comment at the top of post-dialog.html).
const FULL_ORDER = ['2001', '3001', '3002', '3003', '2002', '2011', '2003', '2004', '3004', '3005', '2005', '2012', '2006', '2007', '2008', '2009', '2010'];
const FULL_DEPTHS = [0, 1, 1, 2, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0];

// ---- helpers -----------------------------------------------------------------------------------

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Comment id of a RawComment: reply_comment_id for replies, else comment_id. */
function commentId(item) {
  const u = new URL(item.permalinkHref);
  return u.searchParams.get('reply_comment_id') || u.searchParams.get('comment_id');
}

function fixtureFor(pathname) {
  if (/^\/groups\/testgroup\/posts\/9999\/?$/.test(pathname)) return 'post-empty.html';
  if (/^\/groups\/testgroup\/(posts|permalink)\/[\w.-]+\/?$/.test(pathname)) return 'post-dialog.html';
  if (/^\/groups\/testgroup\/?$/.test(pathname)) return 'feed.html';
  return null;
}

const fixtureCache = new Map();
async function fixtureHtml(name) {
  if (!fixtureCache.has(name)) fixtureCache.set(name, await readFile(new URL(name, FIXTURES), 'utf8'));
  return fixtureCache.get(name);
}

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
});

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const name = fixtureFor(pathname);
    if (!name) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await fixtureHtml(name) });
  });
  return page;
}

async function openPage(url) {
  const page = await newPage();
  await page.goto(url);
  return page;
}

async function waitUntil(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Drive a post dialog to "fully expanded" with the same steps as pw-driver.preparePost:
 * post "See more", sort → All comments, then rounds of wheel-scroll + expanders + comment "See more".
 */
async function preparePostLikeDriver(page, { maxRounds = 12 } = {}) {
  const root = page.locator(ROOT_SEL).last();
  const probe = () => page.evaluate(probePage, PROBE_OPTS);
  const result = { sortChanged: false, clicks: [], rounds: 0, complete: false };

  // Post-level "See more" (not inside a comment article).
  const seeMores = root.getByRole('button', { name: PATTERNS.seeMore });
  for (let i = 0; i < (await seeMores.count()); i++) {
    const btn = seeMores.nth(i);
    if (await btn.evaluate((el) => !el.closest('[role="article"][aria-label]'))) {
      await btn.click();
      break;
    }
  }

  // Sort → "All comments".
  const sortBtn = root.locator('[role="button"][aria-haspopup="menu"]').filter({ hasText: PATTERNS.sortButton }).first();
  if (await sortBtn.count()) {
    if (!PATTERNS.sortAllItem.test(collapse(await sortBtn.innerText()))) {
      await sortBtn.click();
      await page.getByRole('menuitem').filter({ hasText: PATTERNS.sortAllItem }).first().click();
      result.sortChanged = await waitUntil(async () => PATTERNS.sortAllItem.test(collapse(await sortBtn.innerText())));
    }
  }

  let lastCount = (await probe()).commentCount;
  let quietRounds = 0;
  for (let round = 1; round <= maxRounds; round++) {
    result.rounds = round;
    // a. scroll: real wheel events over the dialog + bring the last comment into view.
    const box = await root.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 2500);
    await page.mouse.wheel(0, 2500);
    const lastComment = root.locator('[role="article"][aria-label]').last();
    if (await lastComment.count()) await lastComment.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    // b. expanders, one at a time in DOM order.
    let clicked = 0;
    for (let guard = 0; guard < 25; guard++) {
      const expanders = root.getByRole('button', { name: PATTERNS.expander });
      if (!(await expanders.count())) break;
      const btn = expanders.first();
      result.clicks.push(collapse(await btn.innerText()));
      await btn.click();
      clicked++;
      await page.waitForTimeout(400);
    }

    // c. comment-level "See more".
    for (let guard = 0; guard < 25; guard++) {
      const seeMore = root.locator('[role="article"][aria-label] [role="button"]').filter({ hasText: PATTERNS.seeMore });
      if (!(await seeMore.count())) break;
      await seeMore.first().click();
      clicked++;
      await page.waitForTimeout(150);
    }

    // d. done after 2 quiet rounds.
    const p = await probe();
    const grew = p.commentCount > lastCount;
    lastCount = p.commentCount;
    if (!clicked && !grew && p.expanderCount === 0 && p.seeMoreCount === 0) {
      if (++quietRounds >= 2) {
        result.complete = true;
        break;
      }
    } else {
      quietRounds = 0;
    }
  }
  return result;
}

// ---- serializability -------------------------------------------------------------------------

test('page functions are self-contained and survive fn.toString() serialization', async () => {
  for (const fn of [extractRaw, collectFeedPosts, probePage]) {
    const src = fn.toString();
    assert.match(src, /^function \w+\(opts\) \{/, `${fn.name} must be a plain one-parameter function`);
    const revived = new Function(`return (${src})`)();
    assert.equal(typeof revived, 'function');
    assert.equal(revived.length, 1);
  }

  const page = await openPage(postUrl(1001));
  try {
    // String form, exactly like a serialized injection: no module scope exists in the page.
    const viaString = await page.evaluate(`(${extractRaw.toString()})(${JSON.stringify({ scope: 'auto' })})`);
    const viaFn = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(viaString.rootKind, 'dialog');
    assert.equal(viaString.posts[0].items.length, 5);
    delete viaString.extractedAt;
    delete viaFn.extractedAt;
    assert.deepEqual(viaString, viaFn);

    const probeViaString = await page.evaluate(`(${probePage.toString()})(${JSON.stringify(PROBE_OPTS)})`);
    assert.equal(probeViaString.commentCount, 5);
    // undefined opts → built-in default patterns.
    const probeDefaults = await page.evaluate(`(${probePage.toString()})(undefined)`);
    assert.equal(probeDefaults.expanderCount, probeViaString.expanderCount);
    // Invalid regex → falls back to the default instead of throwing.
    const probeBadRegex = await page.evaluate(probePage, { ...PROBE_OPTS, expanderPattern: '([' });
    assert.equal(probeBadRegex.expanderCount, probeViaString.expanderCount);

    const feedViaString = await page.evaluate(`(${collectFeedPosts.toString()})(undefined)`);
    assert.equal(feedViaString.feedFound, true);
    assert.equal(feedViaString.posts[0].postId, '1001');
  } finally {
    await page.close();
  }
});

// ---- post dialog -----------------------------------------------------------------------------

test('extractRaw + probePage on the post dialog before any expansion (dialog-only scoping)', async () => {
  const page = await openPage(postUrl(1001));
  try {
    // extractRaw / probePage must never mutate the DOM.
    await page.evaluate(() => {
      window.__mutations = 0;
      window.__mo = new MutationObserver((records) => (window.__mutations += records.length));
      window.__mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    const probe = await page.evaluate(probePage, PROBE_OPTS);
    const mutations = await page.evaluate(() => window.__mutations + window.__mo.takeRecords().length);
    assert.equal(mutations, 0, 'extractRaw/probePage mutated the DOM');

    assert.equal(raw.rootKind, 'dialog');
    assert.equal(raw.pageUrl, postUrl(1001));
    assert.equal(raw.pageTitle, 'Test Group | Facebook');
    assert.equal(typeof raw.extractedAt, 'number');
    assert.equal(raw.posts.length, 1);

    const post = raw.posts[0];
    assert.equal(post.permalinkHref, null, 'the dialog has no /posts/ link');
    assert.equal(post.authorName, 'Kyaw Zin Thant', 'group name in profile_name must not be the author');
    assert.match(post.authorHref, /^https:\/\/www\.facebook\.com\/groups\/testgroup\/user\/100001\//);
    assert.equal(post.dateText, '4 October at 18:19');
    assert.equal(post.dateAria, null);
    assert.equal(post.commentCountText, '12');
    assert.equal(post.emptyState, false);
    assert.equal(
      post.text,
      'Do you need a CS degree to become a software engineer in Myanmar? 🤔\n' +
        'I have been working as a developer for five years and I keep hearing different opinions…',
    );

    // Only the 5 initial dialog comments — never the feed preview comment behind the dialog.
    assert.deepEqual(post.items.map(commentId), ['2001', '2002', '2003', '2004', '2005']);
    assert.deepEqual(post.items.map((c) => c.index), [0, 1, 2, 3, 4]);
    assert.ok(!post.items.some((c) => c.authorName === 'Feed Preview Person'));
    assert.equal(new Set(post.items.map((c) => c.left)).size, 1, 'all top-level → same left');

    const [c1, c2, c3, c4, c5] = post.items;
    assert.equal(c1.ariaLabel, 'Comment by Thura Min Oo 2 days ago');
    assert.equal(c1.authorName, 'Thura Min Oo');
    assert.equal(c1.authorHref, 'https://www.facebook.com/groups/testgroup/user/100101/?__cft__[0]=AZX&__tn__=R]-R');
    assert.equal(c1.permalinkHref, 'https://www.facebook.com/groups/testgroup/posts/1001/?comment_id=2001&__cft__[0]=AZX&__tn__=R]-R');
    assert.equal(c1.timeAria, 'Monday 12 October 2026 at 08:54');
    assert.equal(c1.timeText, '2d');
    assert.equal(
      c1.text,
      'Hardly any degree exists that teaches you everything you need on the job.\n' +
        'Is there truly a degree that covers Kubernetes, React and SQL at the same time?',
    );
    assert.equal(c1.reactionLabel, '5 reactions; see who reacted to this');
    assert.deepEqual(c1.attachments, [], 'reaction icons and avatars are not attachments');

    assert.equal(c2.ariaLabel, 'Comment by Chai_lover🍵 3 days ago');
    assert.equal(c2.authorName, 'Chai_lover🍵', 'emoji <img alt> in the author name');
    assert.equal(c2.text, 'Coding with tea 🍵 is the best 😂', 'emoji <img alt> in the body');
    assert.deepEqual(c2.attachments, [], 'emoji are not attachments');
    assert.equal(c2.reactionLabel, null);

    assert.equal(c3.truncated, true);
    assert.equal(
      c3.text,
      'When I started my career I thought a CS degree was required for every job, but after working at three companies I learned that…',
      '"See more" toggle text excluded',
    );

    assert.equal(c4.attachments.length, 1);
    assert.equal(c4.attachments[0].type, 'image');
    assert.equal(c4.attachments[0].alt, 'May be an image of laptop, desk and coffee cup');
    assert.match(c4.attachments[0].src, /^data:image\/svg\+xml,/);
    assert.equal(c4.text, 'Here is my study setup:');
    assert.equal(c5.truncated, false);

    // probePage
    assert.equal(probe.url, postUrl(1001));
    assert.equal(probe.rootKind, 'dialog');
    assert.equal(probe.loginRequired, false);
    assert.equal(probe.blocked, false);
    assert.equal(probe.postArticleFound, true);
    assert.equal(probe.commentCount, 5);
    assert.equal(probe.expanderCount, 3, '"View 2 replies" ×2 + "View more comments" (the feed one behind is out of scope)');
    assert.equal(probe.seeMoreCount, 2, 'post + C3');
    assert.equal(probe.sortLabel, 'Most relevant');
    assert.equal(probe.emptyState, false);
    assert.equal(probe.commentCountText, '12');
    assert.equal(probe.feedbackFound, true);
    assert.equal(probe.loadingCount, 0);
    assert.equal(probe.scrollable.found, true);
    assert.equal(probe.scrollable.scrollTop, 0);
    assert.ok(probe.scrollable.scrollHeight > probe.scrollable.clientHeight, 'inner scroller overflows');
    assert.ok(probe.scrollable.clientHeight > 300 && probe.scrollable.clientHeight < 720);
  } finally {
    await page.close();
  }
});

test('extractRaw scope "feed" reads the feed behind the dialog', async () => {
  const page = await openPage(postUrl(1001));
  try {
    const raw = await page.evaluate(extractRaw, { scope: 'feed' });
    assert.equal(raw.rootKind, 'feed');
    assert.equal(raw.posts.length, 1);
    const [post] = raw.posts;
    assert.equal(post.permalinkHref, 'https://www.facebook.com/groups/testgroup/posts/1001/?__cft__[0]=AZX&__tn__=%2CO%2CP-R');
    assert.equal(post.dateText, '1w');
    assert.equal(post.authorName, 'Kyaw Zin Thant');
    assert.equal(post.commentCountText, '12');
    assert.equal(post.items.length, 1);
    assert.equal(post.items[0].authorName, 'Feed Preview Person');
    assert.equal(commentId(post.items[0]), '2999');
  } finally {
    await page.close();
  }
});

test('driving the dialog like the driver reveals every comment and reply', async () => {
  const page = await openPage(postUrl(1001));
  try {
    const run = await preparePostLikeDriver(page);
    assert.equal(run.sortChanged, true, 'sort switched to All comments');
    assert.equal(run.complete, true, `expansion did not settle: ${JSON.stringify(run)}`);
    assert.ok(!run.clicks.some((t) => /hide/i.test(t)), 'never clicks "Hide replies"');
    assert.deepEqual(
      [...run.clicks].sort(),
      ['View 1 reply', 'View 2 replies', 'View 2 replies', 'View more comments'].sort(),
    );

    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(raw.rootKind, 'dialog');
    const post = raw.posts[0];
    const items = post.items;

    // Totals and pre-order.
    assert.equal(items.length, 17);
    assert.deepEqual(items.map(commentId), FULL_ORDER);
    assert.ok(!items.some((c) => c.authorName === 'Feed Preview Person'));
    assert.equal(items.filter((c) => /^Comment by /.test(c.ariaLabel)).length, 12);
    assert.equal(items.filter((c) => /^Reply by /.test(c.ariaLabel)).length, 5);

    // Threading: indentation (left) encodes depth: 3 distinct values, in depth order.
    const lefts = [...new Set(items.map((c) => c.left))].sort((a, b) => a - b);
    assert.equal(lefts.length, 3);
    assert.deepEqual(items.map((c) => lefts.indexOf(c.left)), FULL_DEPTHS);
    assert.equal(lefts[1] - lefts[0], 61);
    assert.equal(lefts[2] - lefts[0], 103);

    // Permalinks: comment_id = thread root, reply_comment_id = own id.
    for (const c of items) {
      const u = new URL(c.permalinkHref);
      assert.equal(u.pathname, '/groups/testgroup/posts/1001/');
      assert.equal(u.searchParams.get('__cft__[0]'), 'AZX');
      assert.match(c.timeAria, /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{1,2} October 2026 at \d{2}:\d{2}$/);
      assert.match(c.timeText, /^\d+[hdw]$/);
      assert.ok(c.authorName && c.authorHref, `author for ${c.ariaLabel}`);
      assert.equal(c.truncated, false, 'all "See more" expanded');
    }
    const byId = new Map(items.map((c) => [commentId(c), c]));
    const r3 = byId.get('3003');
    assert.equal(r3.ariaLabel, "Reply by Thura Min Oo to Min Thu's reply 18 hours ago");
    assert.equal(r3.permalinkHref, 'https://www.facebook.com/groups/testgroup/posts/1001/?comment_id=2001&reply_comment_id=3003&__cft__[0]=AZX&__tn__=R]-R');
    assert.equal(new URL(byId.get('3001').permalinkHref).searchParams.get('comment_id'), '2001');
    assert.equal(new URL(byId.get('3005').permalinkHref).searchParams.get('comment_id'), '2004');
    assert.equal(byId.get('3001').ariaLabel, "Reply by Aye Chan Moe to Thura Min Oo's comment 1 day ago");
    assert.equal(byId.get('3001').reactionLabel, '1 reaction; see who reacted to this');
    assert.equal(byId.get('2001').reactionLabel, '5 reactions; see who reacted to this');
    assert.equal(items.filter((c) => c.reactionLabel).length, 2);

    // Bodies, emoji, Myanmar text.
    assert.equal(byId.get('3002').text, 'ကျွန်တော်လည်း သဘောတူပါတယ်။');
    assert.equal(byId.get('3005').authorName, 'Chai_lover🍵');
    assert.equal(byId.get('3005').text, 'Is that a matcha 🍵 on the desk?');
    assert.equal(
      byId.get('2003').text,
      'When I started my career I thought a CS degree was required for every job, but after working at three companies I learned that what matters most is how fast you can learn.\n' +
        'Build projects, read the docs, and ask questions in this group!',
    );
    assert.equal(byId.get('2008').text, 'Portfolio > degree.');
    assert.equal(byId.get('2011').authorName, 'LuckyPanda7781');
    assert.equal(byId.get('2012').authorName, 'Crypto Deals Official');

    // Attachments.
    assert.deepEqual(
      byId.get('2007').attachments,
      [{ type: 'link', href: 'https://roadmap.sh/' }],
      'link preview card outside the body → decoded l.facebook.com target; inline body link ignored',
    );
    assert.equal(byId.get('2007').text, 'Roadmap here: https://roadmap.sh/');
    assert.equal(byId.get('2010').text, '', 'sticker-only comment');
    assert.equal(byId.get('2010').attachments.length, 1);
    assert.equal(byId.get('2010').attachments[0].alt, 'Thumbs up sticker');
    assert.equal(byId.get('2004').attachments.length, 1);
    const withAttachments = items.filter((c) => c.attachments.length).map(commentId).sort();
    assert.deepEqual(withAttachments, ['2004', '2007', '2010']);

    // Post after "See more".
    assert.equal(
      post.text,
      'Do you need a CS degree to become a software engineer in Myanmar? 🤔\n' +
        'I have been working as a developer for five years and I keep hearing different opinions about this. Some companies here only hire graduates, others only care about your GitHub.\n' +
        'What do you all think? ဘယ်လိုထင်ကြလဲ',
    );

    const probe = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(probe.commentCount, 17);
    assert.equal(probe.expanderCount, 0);
    assert.equal(probe.seeMoreCount, 0);
    assert.equal(probe.sortLabel, 'All comments');
    assert.equal(probe.commentCountText, '12');
    assert.equal(await page.locator('[role="menu"]').count(), 0, 'sort menu closed');
  } finally {
    await page.close();
  }
});

test('post id comes from the URL and ?variant=minus1 omits C5', async () => {
  const page = await openPage(postUrl(1002, '?variant=minus1'));
  try {
    const before = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.deepEqual(before.posts[0].items.map(commentId), ['100202001', '100202002', '100202003', '100202004']);
    for (const c of before.posts[0].items) assert.match(c.permalinkHref, /\/groups\/testgroup\/posts\/1002\/\?comment_id=/);

    const run = await preparePostLikeDriver(page);
    assert.equal(run.complete, true);
    const after = await page.evaluate(extractRaw, { scope: 'auto' });
    const ids = after.posts[0].items.map(commentId);
    assert.equal(ids.length, 16);
    assert.deepEqual(ids, FULL_ORDER.filter((id) => id !== '2005').map((id) => `10020${id}`));
  } finally {
    await page.close();
  }
});

test('empty post: "No comments yet", no count, no sort control', async () => {
  const page = await openPage(postUrl(9999));
  try {
    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(raw.rootKind, 'dialog');
    assert.equal(raw.posts.length, 1);
    const post = raw.posts[0];
    assert.deepEqual(post.items, []);
    assert.equal(post.emptyState, true);
    assert.equal(post.commentCountText, null, 'the Like count must not be taken as the comment count');
    assert.equal(post.authorName, 'Aung Ko Ko');
    assert.equal(post.dateText, 'Yesterday at 21:05');
    assert.equal(post.text, 'Anyone going to the Yangon tech meetup this Saturday?\nဒီစနေနေ့ meetup ကို ဘယ်သူတွေ လာမလဲ။');

    const probe = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(probe.rootKind, 'dialog');
    assert.equal(probe.postArticleFound, true);
    assert.equal(probe.commentCount, 0);
    assert.equal(probe.expanderCount, 0);
    assert.equal(probe.seeMoreCount, 0);
    assert.equal(probe.sortLabel, null);
    assert.equal(probe.emptyState, true);
    assert.equal(probe.commentCountText, null);
    assert.equal(probe.feedbackFound, true, 'the "Leave a comment" button exists without a number');
    assert.equal(probe.scrollable.found, true);
  } finally {
    await page.close();
  }
});

// ---- feed ------------------------------------------------------------------------------------

test('extractRaw + probePage on the group feed', async () => {
  const page = await openPage(FEED_URL);
  try {
    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(raw.rootKind, 'feed');
    assert.equal(raw.posts.length, 5);
    assert.deepEqual(
      raw.posts.map((p) => p.permalinkHref.match(/\/posts\/(\d+)\//)[1]),
      ['1001', '1002', '1003', '1004', '1005'],
    );
    const [p1, p2, p3, p4] = raw.posts;
    assert.equal(p1.permalinkHref, 'https://www.facebook.com/groups/testgroup/posts/1001/?__cft__[0]=AZX&__tn__=%2CO%2CP-R');
    assert.equal(p1.authorName, 'Kyaw Zin Thant');
    assert.equal(p1.dateText, '1h');
    assert.equal(p1.dateAria, null);
    assert.equal(p1.commentCountText, '1');
    assert.equal(p1.text, 'Which backend framework do you recommend for a beginner? #1');
    assert.equal(p1.items.length, 1, 'feed preview comment');
    assert.equal(p2.text, 'မင်္ဂလာပါ။ React Native နဲ့ Flutter ဘယ်ဟာ ပိုကောင်းလဲ။ #2');
    assert.equal(p2.items.length, 0);
    assert.equal(p3.commentCountText, '15');
    assert.equal(p3.items[0].permalinkHref.includes('/posts/1003/?comment_id=91003'), true);
    assert.equal(p4.authorName, 'Chai_lover🍵');
    assert.equal(p4.commentCountText, null, 'no comments: Like count must not be used');

    const probe = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(probe.rootKind, 'feed');
    assert.equal(probe.postArticleFound, true);
    assert.equal(probe.commentCount, 3);
    assert.equal(probe.expanderCount, 2);
    assert.equal(probe.sortLabel, null);
    assert.equal(probe.loginRequired, false);
    assert.equal(probe.blocked, false);
    assert.equal(probe.scrollable.found, true);
  } finally {
    await page.close();
  }
});

test('collectFeedPosts collects all 30 posts despite virtualization and recovers the lazy href by hovering', async () => {
  const page = await openPage(FEED_URL);
  try {
    const seen = new Map();
    const hovered = [];
    let markHoverFrom = 0;
    let lazyMissingBeforeHover = false;
    let stale = 0;
    // Keep the pointer beside the feed column so wheel scrolling never hovers post links by accident.
    const parkMouse = () => page.mouse.move(1260, 360);
    const add = (scan) => {
      for (const p of scan.posts) if (!seen.has(p.postId)) seen.set(p.postId, p);
    };

    await parkMouse();
    for (let round = 0; round < 60 && seen.size < 30 && stale < 6; round++) {
      const before = seen.size;
      let scan = await page.evaluate(collectFeedPosts, { markHoverFrom });
      assert.equal(scan.feedFound, true);
      add(scan);
      if (scan.missing.length) {
        markHoverFrom += scan.missing.length;
        for (const { hoverId } of scan.missing) {
          const target = page.locator(`[data-fbcs-hover="${hoverId}"]`);
          const info = await target.evaluate((el) => ({
            href: el.getAttribute('href'),
            text: el.textContent,
            article: el.closest('[role="article"]').getAttribute('aria-labelledby'),
          }));
          if (info.article.includes('_r_1013a_')) lazyMissingBeforeHover = info.href === '#';
          hovered.push(info);
          await target.hover();
        }
        scan = await page.evaluate(collectFeedPosts, { markHoverFrom });
        markHoverFrom += scan.missing.length;
        add(scan);
        await parkMouse();
      }
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(350);
      stale = seen.size > before ? 0 : stale + 1;
    }

    const ids = [...seen.keys()].sort();
    assert.ok(!seen.has('5555'), 'a group-post link pasted in a post body is never a permalink');
    assert.equal(seen.size, 30);
    assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => String(1001 + i)));
    for (const [id, p] of seen) {
      assert.equal(p.permalinkHref.startsWith(`https://www.facebook.com/groups/testgroup/posts/${id}/`), true);
      assert.ok(p.authorName, `author of ${id}`);
      assert.match(p.dateText, /^\d+[hd]$/);
      assert.ok(p.textPreview.length > 0 && p.textPreview.length <= 160);
      const i = Number(id) - 1001;
      assert.equal(p.commentCountText, i % 4 === 3 ? null : String(((i * 7) % 23) + 1), `comment count of ${id}`);
    }

    // The lazy post was reported as missing, hovered via its data-fbcs-hover mark, then recovered.
    assert.equal(lazyMissingBeforeHover, true, 'post 1013 was first reported in `missing`');
    assert.equal(hovered.length, 1, 'only post 1013 lacks a permalink');
    assert.equal(hovered[0].text, '2d');
    assert.equal(seen.get('1013').permalinkHref, 'https://www.facebook.com/groups/testgroup/posts/1013/?__cft__[0]=AZX&__tn__=%2CO%2CP-R');
    assert.equal(seen.get('1013').dateText, '2d');

    // Virtualization really happened: posts far above are emptied, so one scan alone is not enough.
    const finalScan = await page.evaluate(collectFeedPosts, { markHoverFrom });
    const wrappers = await page.locator('[role="feed"] > div > [role="article"]').count();
    assert.equal(wrappers, 30);
    assert.ok(finalScan.renderedCount < 30, `renderedCount ${finalScan.renderedCount}`);
    assert.ok(!finalScan.posts.some((p) => p.postId === '1001'), 'post 1001 is virtualized at the bottom');
    const emptied = await page.evaluate(
      () => [...document.querySelectorAll('[role="feed"] > div > [role="article"]')].filter((a) => !a.textContent.trim() && !a.querySelector('a')).length,
    );
    assert.ok(emptied > 0, 'some posts were emptied by virtualization');
  } finally {
    await page.close();
  }
});

// ---- edge cases via setContent -------------------------------------------------------------

test('textOf / body / attachment rules on hand-written markup', async () => {
  const page = await newPage();
  try {
    const avatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>');
    await page.setContent(`<!doctype html><html><head><title>Edge</title></head><body>
      <div role="dialog"><div style="height:300px;overflow-y:auto">
        <div role="article" aria-labelledby="x">
          <a href="https://www.facebook.com/photo/?fbid=1"><img alt="photo alt text" width="300" height="200" src="${avatar}"></a>
          <h3><a href="https://www.facebook.com/profile.php?id=4242&amp;__tn__=x"><span>Pro File</span></a></h3>
          <span><a role="link"><span>Today at 9:05 AM</span></a></span>
          <div data-ad-preview="message"><div dir="auto">line1<br>line2<br><br><br><br>line3</div></div>
          <div role="article" aria-label="Comment by Aye Bo 5m">
            <a href="https://www.facebook.com/aye.bo.77"><img width="40" height="40" alt="Aye Bo" src="${avatar}"></a>
            <a href="https://www.facebook.com/aye.bo.77?__tn__=R"><span dir="auto">Aye Bo</span></a>
            <a href="https://www.facebook.com/groups/g/posts/1/?comment_id=11" aria-label="Wednesday 14 October 2026 at 09:00"><span dir="auto">5m</span></a>
            <span dir="auto"><div dir="auto">  hello
              <b>world</b>  </div><div dir="auto">second<br>third</div><div dir="auto">Hidden <span style="display:none">offscreen</span> text … <div role="button">See less</div></div></span>
            <span dir="auto">Top fan and a much longer badge text that is not the body</span>
          </div>
          <div role="article" aria-label="Comment by Ko Ko 5m">
            <a href="https://www.facebook.com/profile.php?id=55"><span dir="auto">Ko Ko</span></a>
            <a href="https://www.facebook.com/groups/g/posts/1/?comment_id=12"><span>5m</span></a>
            <span dir="auto">Only span text here, no paragraphs</span>
            <span dir="auto">Top fan</span>
          </div>
          <div role="article" aria-label="Comment by Video Person 5m">
            <a href="https://www.facebook.com/profile.php?id=56"><span dir="auto">Video Person</span></a>
            <a href="https://www.facebook.com/groups/g/posts/1/?comment_id=13"><span>5m</span></a>
            <a href="https://www.facebook.com/watch/?v=777"><video width="320" height="180"></video></a>
          </div>
          <div role="button"><span>Try again later</span></div>
        </div>
      </div></div></body></html>`);

    const raw = await page.evaluate(extractRaw);
    assert.equal(raw.rootKind, 'dialog');
    const post = raw.posts[0];
    assert.equal(post.authorName, 'Pro File', 'photo link skipped; profile.php link used');
    assert.equal(post.dateText, 'Today at 9:05 AM');
    assert.equal(post.text, 'line1\nline2\n\nline3', 'blank-line runs collapse to one');
    assert.equal(post.items.length, 3);

    const [a, b, c] = post.items;
    assert.equal(a.authorName, 'Aye Bo');
    assert.equal(a.text, 'hello world\nsecond\nthird\nHidden offscreen text …', 'hidden text kept, See less dropped');
    assert.deepEqual(a.attachments, [], 'avatar image inside the profile link is not an attachment');
    assert.equal(a.timeText, '5m');
    assert.equal(b.text, 'Only span text here, no paragraphs', 'largest dir=auto candidate when no paragraphs');
    assert.equal(c.text, '');
    assert.deepEqual(c.attachments, [{ type: 'video', href: 'https://www.facebook.com/watch/?v=777' }]);

    const probe = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(probe.blocked, false, 'text inside a post dialog is not a block notice');
    assert.equal(probe.loginRequired, false);
  } finally {
    await page.close();
  }
});

test('probePage detects login walls and block notices', async () => {
  const page = await newPage();
  try {
    await page.setContent(`<!doctype html><html><body>
      <form action="https://www.facebook.com/login/device-based/regular/login/" method="post">
        <input name="email" type="text"><input name="pass" type="password"><button type="submit">Log in</button>
      </form></body></html>`);
    let probe = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(probe.rootKind, 'none');
    assert.equal(probe.loginRequired, true);
    assert.equal(probe.blocked, false);
    assert.equal(probe.postArticleFound, false);
    assert.equal(probe.commentCount, 0);

    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(raw.rootKind, 'none');
    assert.deepEqual(raw.posts, []);
    const feedScan = await page.evaluate(collectFeedPosts, {});
    assert.deepEqual(feedScan, { posts: [], missing: [], feedFound: false, renderedCount: 0 });

    await page.setContent(`<!doctype html><html><body>
      <div role="feed"><div role="article" aria-labelledby="a"><span>post</span></div></div>
      <div role="alertdialog"><span>You’re Temporarily Blocked</span><span>It looks like you were misusing this feature by going too fast.</span></div>
      </body></html>`);
    probe = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(probe.rootKind, 'feed');
    assert.equal(probe.blocked, true);
    assert.equal(probe.loginRequired, false);
  } finally {
    await page.close();
  }
});

// ---- post root, post permalink and author rules (live findings) ------------------------------

test('a post URL loaded directly: the feed in [role=main] is never taken for the post', async () => {
  // Live: a fresh navigation to a post URL shows the home/group feed in [role=main] until the
  // post's dialog mounts. Before it does, there is no post root — not 'main'.
  const page = await openPage(postUrl(1001, '?dialogDelay=1500'));
  try {
    const before = await page.evaluate(extractRaw, { scope: 'auto' });
    const probeBefore = await page.evaluate(probePage, PROBE_OPTS);
    assert.equal(before.rootKind, 'feed');
    assert.equal(probeBefore.rootKind, 'feed');
    assert.equal(probeBefore.emptyState, false);
    assert.equal(probeBefore.commentCountText, null, 'no post view yet');

    await page.locator(ROOT_SEL).waitFor({ timeout: 5000 });
    const after = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(after.rootKind, 'dialog');
    assert.equal(after.posts[0].items.length, 5);
  } finally {
    await page.close();
  }
});

test('a single-post [role=main] (permalink layout) is the root; a main with several posts is not', async () => {
  const page = await newPage();
  const comment = (cid) =>
    `<div role="article" aria-label="Comment by Ko Ko 1h"><a href="${ORIGIN}/groups/testgroup/user/55/"><span dir="auto">Ko Ko</span></a>` +
    `<a href="${ORIGIN}/groups/testgroup/posts/777/?comment_id=${cid}" aria-label="Wednesday 14 October 2026 at 09:00"><span>1h</span></a>` +
    `<span dir="auto"><div dir="auto">hi ${cid}</div></span></div>`;
  const post = (n) =>
    `<div role="article" aria-labelledby="p${n}"><a href="${ORIGIN}/groups/testgroup/user/1/"><span>Author ${n}</span></a>` +
    `<div data-ad-rendering-role="story_message"><div dir="auto">Post ${n}</div></div>${comment(`9${n}`)}</div>`;
  const pages = {
    '/groups/testgroup/permalink/777/': `<!doctype html><html><body><div role="main">${post(1)}</div></body></html>`,
    '/groups/testgroup/permalink/778/': `<!doctype html><html><body><div role="main">${post(1)}${post(2)}</div></body></html>`,
  };
  await page.route(`${ORIGIN}/groups/testgroup/permalink/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] || '' }),
  );
  try {
    await page.goto(`${ORIGIN}/groups/testgroup/permalink/777/`);
    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    assert.equal(raw.rootKind, 'main');
    assert.equal(raw.posts.length, 1);
    assert.equal(raw.posts[0].items.length, 1);
    assert.equal((await page.evaluate(probePage, PROBE_OPTS)).rootKind, 'main');

    await page.goto(`${ORIGIN}/groups/testgroup/permalink/778/`);
    assert.equal((await page.evaluate(extractRaw, { scope: 'auto' })).rootKind, 'none');
    assert.equal((await page.evaluate(probePage, PROBE_OPTS)).rootKind, 'none');
  } finally {
    await page.close();
  }
});

test('a link to another group post pasted in the post body is never the dialog post\'s permalink', async () => {
  const page = await openPage(postUrl(1001, '?bodyLink=5555'));
  try {
    const raw = await page.evaluate(extractRaw, { scope: 'auto' });
    const post = raw.posts[0];
    assert.match(post.text, /Related: https:\/\/www\.facebook\.com\/groups\/testgroup\/posts\/5555\//);
    assert.equal(post.permalinkHref, null, 'the body link is not the post permalink');
    assert.equal(post.dateAria, null);
    assert.equal(post.dateText, '4 October at 18:19');
    assert.equal(post.authorName, 'Kyaw Zin Thant');
    const { posts, comments } = normalizeExtraction(raw, { savedAt: new Date().toISOString(), mode: 'post' });
    assert.equal(posts[0].id, '1001');
    assert.ok(comments.every((c) => c.postId === '1001'));
  } finally {
    await page.close();
  }
});

test('feed: only the header link before the body is a post permalink', async () => {
  const page = await newPage();
  try {
    const feedPost = (n, headerHref, extra = '') =>
      `<div role="article" aria-labelledby="h${n}">` +
      `<h3><a href="${ORIGIN}/groups/g/user/${n}/"><span>Author ${n}</span></a></h3>` +
      `<span><a href="${headerHref}"><span>${n}h</span></a></span>` +
      `<div data-ad-rendering-role="story_message"><div data-ad-preview="message"><div dir="auto">Body ${n}: ` +
      `<a href="${ORIGIN}/groups/g/posts/5555/">${ORIGIN}/groups/g/posts/5555/</a></div></div></div>${extra}</div>`;
    // Post 2's header link is still lazy ("#"); a shared post after its body links /posts/6666/.
    const shared = `<div class="attachment"><a href="${ORIGIN}/groups/g/posts/6666/"><span>3d</span></a></div>`;
    await page.setContent(
      `<!doctype html><html><body><div role="feed">` +
        `<div>${feedPost(1, `${ORIGIN}/groups/g/posts/1111/?__cft__[0]=AZ`)}</div>` +
        `<div>${feedPost(2, '#', shared)}</div>` +
        `</div></body></html>`,
    );
    const raw = await page.evaluate(extractRaw, { scope: 'feed' });
    assert.deepEqual(raw.posts.map((p) => p.permalinkHref), [`${ORIGIN}/groups/g/posts/1111/?__cft__[0]=AZ`, null]);
    assert.equal(raw.posts[0].dateText, '1h');

    const scan = await page.evaluate(collectFeedPosts, { markHoverFrom: 0 });
    assert.deepEqual(scan.posts.map((p) => p.postId), ['1111']);
    assert.equal(scan.missing.length, 1, 'post 2 is reported missing so it gets hovered');
    assert.equal(await page.locator('[data-fbcs-hover="0"]').innerText(), '2h', 'its header time link is the hover target');
  } finally {
    await page.close();
  }
});

test('comment author: only a profile link (or the aria-label name) before the timestamp', async () => {
  const page = await newPage();
  try {
    const t = (cid) => `<a href="${ORIGIN}/groups/g/posts/1/?comment_id=${cid}" aria-label="Wednesday 14 October 2026 at 09:00"><span>5m</span></a>`;
    await page.setContent(`<!doctype html><html><body><div role="dialog"><div role="article" aria-labelledby="x">
      <a href="${ORIGIN}/groups/g/user/1/"><span>Post Author</span></a>
      <div role="article" aria-label="Comment by BrightOtter3141 5 minutes ago">
        <span dir="auto">BrightOtter3141</span> ${t(11)}
        <span dir="auto"><div dir="auto">Thanks <a href="${ORIGIN}/htet.wai.yan.soe">Nay Lin Htike</a>!</div></span>
        <a href="${ORIGIN}/hashtag/react"><span>#react</span></a>
      </div>
      <div role="article" aria-label="Comment by Real Name 5 minutes ago">
        <a href="${ORIGIN}/groups/g/badges/"><span>Top contributor</span></a>
        <a href="${ORIGIN}/groups/g/user/123/"><span dir="auto">Real Name</span></a> ${t(12)}
        <span dir="auto"><div dir="auto">hello</div></span>
      </div>
      <div role="article" aria-label="Reply by Anon Person to Real Name's comment 5 minutes ago">
        <a role="link" tabindex="0"><span dir="auto">Anon Person</span></a> ${t(12)}&amp;reply_comment_id=13
        <span dir="auto"><div dir="auto">a reply</div></span>
      </div>
    </div></div></body></html>`);
    const raw = await page.evaluate(extractRaw);
    const [a, b, c] = raw.posts[0].items;
    assert.equal(a.authorName, null, 'a mention in the body or a later link is never the author');
    assert.equal(a.authorHref, null);
    assert.equal(b.authorName, 'Real Name', 'a badge link before the name is skipped');
    assert.match(b.authorHref, /\/groups\/g\/user\/123\//);
    assert.equal(c.authorName, 'Anon Person', 'a non-profile link whose text is the aria-label name');

    const { comments } = normalizeExtraction(raw, { savedAt: new Date().toISOString(), mode: 'post' });
    assert.equal(comments[0].authorName, 'BrightOtter3141', 'normalize falls back to the aria-label');
    assert.equal(comments[0].authorUrl, null);
  } finally {
    await page.close();
  }
});

test('probePage: chat windows, hidden or long dialogs are not block notices', async () => {
  const page = await newPage();
  try {
    const feed = '<div role="feed"><div role="article" aria-labelledby="a"><span>post</span></div></div>';
    const cases = [
      // Messenger chat window whose history says "try again later".
      [`<div role="dialog" aria-label="Chat with Ko Ko"><div role="row">I'll try again later</div><div role="textbox" contenteditable="true"></div></div>`, false],
      [`<div role="dialog"><span>Something went wrong.</span><div contenteditable="true">try again later</div></div>`, false],
      [`<div role="alertdialog" hidden><span>You're Temporarily Blocked</span></div>`, false],
      [`<div role="dialog"><p>${'Long help text. '.repeat(80)}Try again later.</p></div>`, false],
      // Facebook's rate-limit notice.
      [`<div role="dialog"><h2>Try Again Later</h2><span>We limit how often you can post, comment or do other things in a given amount of time.</span></div>`, true],
      [`<div role="alertdialog"><span>You can't use this feature right now</span></div>`, true],
    ];
    for (const [html, expected] of cases) {
      await page.setContent(`<!doctype html><html><body>${feed}${html}</body></html>`);
      const probe = await page.evaluate(probePage, PROBE_OPTS);
      assert.equal(probe.blocked, expected, html.slice(0, 80));
    }
  } finally {
    await page.close();
  }
});
