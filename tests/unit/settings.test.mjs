import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../../src/lib/constants.js';
import {
  buildGroupFeedUrl,
  compilePatterns,
  getSettings,
  isGroupFeedUrl,
  isValidPattern,
  saveSettings,
} from '../../src/lib/settings.js';

/** In-memory chrome.storage.local stub (MV3 promise API). */
function installChromeStub() {
  const store = new Map();
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = keys == null ? [...store.keys()] : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = clone(store.get(k));
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) store.set(k, clone(v));
        },
      },
    },
  };
  return store;
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

describe('getSettings / saveSettings', () => {
  let store;
  beforeEach(() => {
    store = installChromeStub();
  });

  test('returns defaults when nothing is stored', async () => {
    assert.deepEqual(await getSettings(), DEFAULT_SETTINGS);
  });

  test('merges stored values over defaults', async () => {
    store.set(SETTINGS_KEY, { maxPosts: 50, expandReplies: false });
    const s = await getSettings();
    assert.equal(s.maxPosts, 50);
    assert.equal(s.expandReplies, false);
    assert.equal(s.groupUrl, DEFAULT_SETTINGS.groupUrl);
    assert.equal(s.actionDelayMs, DEFAULT_SETTINGS.actionDelayMs);
  });

  test('saveSettings merges patches, persists, and returns the merged settings', async () => {
    const first = await saveSettings({ maxPosts: 30 });
    assert.equal(first.maxPosts, 30);
    const second = await saveSettings({ feedSort: 'TOP_POSTS' });
    assert.equal(second.maxPosts, 30);
    assert.equal(second.feedSort, 'TOP_POSTS');
    assert.deepEqual(store.get(SETTINGS_KEY), second);
    assert.deepEqual(await getSettings(), second);
  });

  test('clamps numeric settings to their ranges', async () => {
    let s = await saveSettings({
      maxPosts: 0,
      skipSavedWithinHours: -5,
      actionDelayMs: 5,
      maxExpandRounds: 0,
      postTimeoutSec: 1,
    });
    assert.equal(s.maxPosts, 1);
    assert.equal(s.skipSavedWithinHours, 0);
    assert.equal(s.actionDelayMs, 100);
    assert.equal(s.maxExpandRounds, 1);
    assert.equal(s.postTimeoutSec, 30);

    s = await saveSettings({
      maxPosts: 10_000,
      skipSavedWithinHours: 99_999,
      actionDelayMs: 60_000,
      maxExpandRounds: 999,
      postTimeoutSec: 99_999,
    });
    assert.equal(s.maxPosts, 500);
    assert.equal(s.skipSavedWithinHours, 8760);
    assert.equal(s.actionDelayMs, 10000);
    assert.equal(s.maxExpandRounds, 200);
    assert.equal(s.postTimeoutSec, 1800);
  });

  test('accepts numeric strings, rounds, and resets garbage to defaults', async () => {
    const s = await saveSettings({ maxPosts: ' 42 ', actionDelayMs: 750.6, maxExpandRounds: 'abc', postTimeoutSec: null });
    assert.equal(s.maxPosts, 42);
    assert.equal(s.actionDelayMs, 751);
    assert.equal(s.maxExpandRounds, DEFAULT_SETTINGS.maxExpandRounds);
    assert.equal(s.postTimeoutSec, DEFAULT_SETTINGS.postTimeoutSec);
  });

  test('validates booleans, feedSort, empty strings and drops unknown keys', async () => {
    const s = await saveSettings({
      sortAllComments: 'false',
      expandSeeMore: 'yes',
      feedSort: 'bogus',
      groupUrl: '   ',
      expanderPattern: '',
      somethingElse: 1,
    });
    assert.equal(s.sortAllComments, false);
    assert.equal(s.expandSeeMore, DEFAULT_SETTINGS.expandSeeMore);
    assert.equal(s.feedSort, DEFAULT_SETTINGS.feedSort);
    assert.equal(s.groupUrl, DEFAULT_SETTINGS.groupUrl);
    assert.equal(s.expanderPattern, DEFAULT_SETTINGS.expanderPattern);
    assert.equal('somethingElse' in s, false);
  });

  test('saving DEFAULT_SETTINGS resets everything', async () => {
    await saveSettings({ maxPosts: 99, expandReplies: false });
    assert.deepEqual(await saveSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS);
  });
});

describe('buildGroupFeedUrl', () => {
  test('default settings → chronological feed of the default group', () => {
    assert.equal(
      buildGroupFeedUrl(DEFAULT_SETTINGS),
      'https://www.facebook.com/groups/myanmarsoftwareengineers?sorting_setting=CHRONOLOGICAL',
    );
  });

  test("'DEFAULT' sort adds no parameter (and removes an existing one)", () => {
    assert.equal(
      buildGroupFeedUrl({ ...DEFAULT_SETTINGS, feedSort: 'DEFAULT' }),
      'https://www.facebook.com/groups/myanmarsoftwareengineers',
    );
    assert.equal(
      buildGroupFeedUrl({ groupUrl: 'https://www.facebook.com/groups/abc/?sorting_setting=TOP_POSTS', feedSort: 'DEFAULT' }),
      'https://www.facebook.com/groups/abc/',
    );
  });

  test('keeps an existing query string and replaces sorting_setting', () => {
    assert.equal(
      buildGroupFeedUrl({ groupUrl: 'https://web.facebook.com/groups/abc/?ref=share', feedSort: 'RECENT_ACTIVITY' }),
      'https://web.facebook.com/groups/abc/?ref=share&sorting_setting=RECENT_ACTIVITY',
    );
    assert.equal(
      buildGroupFeedUrl({ groupUrl: 'https://www.facebook.com/groups/abc?sorting_setting=TOP_POSTS&x=1', feedSort: 'CHRONOLOGICAL' }),
      'https://www.facebook.com/groups/abc?sorting_setting=CHRONOLOGICAL&x=1',
    );
  });

  test('accepts scheme-less URLs and bare slugs; drops the hash', () => {
    assert.equal(
      buildGroupFeedUrl({ groupUrl: 'facebook.com/groups/abc', feedSort: 'TOP_POSTS' }),
      'https://facebook.com/groups/abc?sorting_setting=TOP_POSTS',
    );
    assert.equal(
      buildGroupFeedUrl({ groupUrl: 'myanmarsoftwareengineers', feedSort: 'CHRONOLOGICAL' }),
      'https://www.facebook.com/groups/myanmarsoftwareengineers?sorting_setting=CHRONOLOGICAL',
    );
    assert.equal(
      buildGroupFeedUrl({ groupUrl: 'https://www.facebook.com/groups/abc#top', feedSort: 'DEFAULT' }),
      'https://www.facebook.com/groups/abc',
    );
  });

  test('empty groupUrl falls back to the default group', () => {
    assert.equal(
      buildGroupFeedUrl({ groupUrl: '', feedSort: 'CHRONOLOGICAL' }),
      'https://www.facebook.com/groups/myanmarsoftwareengineers?sorting_setting=CHRONOLOGICAL',
    );
  });
});

describe('isGroupFeedUrl (crawl skips opening the feed only when already on it)', () => {
  const G = 'https://www.facebook.com/groups/myanmarsoftwareengineers';
  const s = (feedSort) => ({ groupUrl: G, feedSort });

  test('the main feed with the same sort', () => {
    assert.equal(isGroupFeedUrl(`${G}/?sorting_setting=CHRONOLOGICAL`, s('CHRONOLOGICAL')), true);
    assert.equal(isGroupFeedUrl(`${G}?sorting_setting=chronological`, s('CHRONOLOGICAL')), true);
    assert.equal(isGroupFeedUrl(`${G}/discussion/?sorting_setting=TOP_POSTS`, s('TOP_POSTS')), true);
    assert.equal(isGroupFeedUrl(`${G}/`, s('DEFAULT')), true);
    assert.equal(isGroupFeedUrl(`${G}`, s('DEFAULT')), true);
    // web.facebook.com and slug case do not matter.
    assert.equal(isGroupFeedUrl('https://web.facebook.com/groups/MyanmarSoftwareEngineers/?sorting_setting=CHRONOLOGICAL', s('CHRONOLOGICAL')), true);
  });

  test('another sort, or none when one is chosen', () => {
    assert.equal(isGroupFeedUrl(`${G}/`, s('CHRONOLOGICAL')), false, "Facebook's default order is not the chosen one");
    assert.equal(isGroupFeedUrl(`${G}/?sorting_setting=TOP_POSTS`, s('CHRONOLOGICAL')), false);
    assert.equal(isGroupFeedUrl(`${G}/?sorting_setting=CHRONOLOGICAL`, s('DEFAULT')), false);
  });

  test('other group pages, other groups, other sites', () => {
    for (const sub of ['members', 'about', 'media', 'user/1000123/', 'posts/123/', 'permalink/123/', 'search/?q=x']) {
      assert.equal(isGroupFeedUrl(`${G}/${sub}`, s('DEFAULT')), false, sub);
    }
    assert.equal(isGroupFeedUrl('https://www.facebook.com/groups/othergroup/', s('DEFAULT')), false);
    assert.equal(isGroupFeedUrl('https://www.facebook.com/', s('DEFAULT')), false);
    assert.equal(isGroupFeedUrl('https://m.facebook.com/groups/myanmarsoftwareengineers/', s('DEFAULT')), false);
    assert.equal(isGroupFeedUrl('https://example.com/groups/myanmarsoftwareengineers/', s('DEFAULT')), false);
    assert.equal(isGroupFeedUrl('not a url', s('DEFAULT')), false);
  });
});

describe('compilePatterns', () => {
  const p = compilePatterns(DEFAULT_SETTINGS);

  test('returns case-insensitive RegExps', () => {
    for (const key of ['expander', 'seeMore', 'sortButton', 'sortAllItem']) {
      assert.ok(p[key] instanceof RegExp, key);
      assert.ok(p[key].flags.includes('i'), key);
    }
  });

  const expanders = [
    'View 3 replies',
    'View 1 reply',
    'View more comments',
    'View more answers',
    'View previous comments',
    'View all 12 replies',
    'View 2 more replies',
    'View more replies',
    '5 Replies',
    'View 1 previous reply',
    'view  3\n replies', // whitespace is collapsed before testing
    'View 1,234 more comments',
  ];
  for (const label of expanders) {
    test(`expander matches ${JSON.stringify(label)}`, () => assert.ok(p.expander.test(collapse(label))));
  }

  const notExpanders = [
    'Hide replies',
    'Hide',
    'Reply',
    'Share',
    'Like',
    'See more',
    'See less',
    'Most relevant',
    'All comments',
    'Write a comment…',
    'Follow',
    'Hide 3 replies',
    'React',
  ];
  for (const label of notExpanders) {
    test(`expander does not match ${JSON.stringify(label)}`, () => assert.equal(p.expander.test(collapse(label)), false));
  }

  test('seeMore matches only "See more"', () => {
    assert.ok(p.seeMore.test('See more'));
    assert.ok(p.seeMore.test(collapse(' see   more ')));
    for (const label of ['See less', 'See more comments', 'View more comments', 'See more of this', 'Hide']) {
      assert.equal(p.seeMore.test(collapse(label)), false, label);
    }
  });

  test('sortButton matches sort labels', () => {
    for (const label of ['Most relevant', 'Newest', 'All comments', 'Top comments', 'most recent', 'Oldest']) {
      assert.ok(p.sortButton.test(collapse(label)), label);
    }
    for (const label of ['View more comments', 'Most relevant comments here', 'Like', 'Reply']) {
      assert.equal(p.sortButton.test(collapse(label)), false, label);
    }
  });

  test('sortAllItem matches the "All comments" menu item after whitespace collapse', () => {
    assert.ok(p.sortAllItem.test(collapse('All comments\nShow all comments, including potential spam.')));
    assert.equal(p.sortAllItem.test(collapse('Most relevant\nShow friends\' comments and the most engaging comments first.')), false);
    assert.equal(p.sortAllItem.test(collapse('Newest\nShow all comments with the newest comments first.')), false);
  });

  test('invalid or empty patterns fall back to the defaults', () => {
    const q = compilePatterns({ ...DEFAULT_SETTINGS, expanderPattern: '(unclosed', seeMorePattern: '', sortButtonPattern: '[', sortAllItemPattern: undefined });
    assert.equal(q.expander.source, new RegExp(DEFAULT_SETTINGS.expanderPattern, 'i').source);
    assert.equal(q.seeMore.source, new RegExp(DEFAULT_SETTINGS.seeMorePattern, 'i').source);
    assert.equal(q.sortButton.source, new RegExp(DEFAULT_SETTINGS.sortButtonPattern, 'i').source);
    assert.equal(q.sortAllItem.source, new RegExp(DEFAULT_SETTINGS.sortAllItemPattern, 'i').source);
    assert.ok(q.expander.test('View 3 replies'));
  });

  test('custom valid patterns are used', () => {
    const q = compilePatterns({ ...DEFAULT_SETTINGS, seeMorePattern: '^(see more|ပိုမိုကြည့်ရှုရန်)$' });
    assert.ok(q.seeMore.test('ပိုမိုကြည့်ရှုရန်'));
    assert.ok(q.seeMore.test('SEE MORE'));
  });

  test('isValidPattern', () => {
    assert.equal(isValidPattern('^a+$'), true);
    assert.equal(isValidPattern('(a'), false);
    assert.equal(isValidPattern(''), false);
    assert.equal(isValidPattern(null), false);
  });
});
