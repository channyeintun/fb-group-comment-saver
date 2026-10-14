import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { djb2, normalizeExtraction, parseCount } from '../../src/lib/normalize.js';

// ---------------------------------------------------------------------------------------------
// Fixtures mirroring SPEC §1 (observed DOM): flat pre-order comment articles, indentation via
// `left`, permalinks with comment_id / reply_comment_id and tracking params.
// ---------------------------------------------------------------------------------------------

const G = 'myanmarsoftwareengineers';
const BASE = `https://www.facebook.com/groups/${G}`;
const POST_ID = '1234567890123456';
const TRACK = '&__cft__[0]=AZXk2abc-def_GHI&__tn__=R]-R';
const SAVED_AT = '2026-10-13T03:00:00.000Z';
const EXTRACTED_AT = new Date(2026, 9, 13, 9, 0).getTime();
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const local = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).toISOString();
const ago = (ms) => new Date(EXTRACTED_AT - ms).toISOString();

const commentLink = (postId, cid, rid) =>
  `${BASE}/posts/${postId}/?comment_id=${cid}${rid ? `&reply_comment_id=${rid}` : ''}${TRACK}`;
const userLink = (uid) => `${BASE}/user/${uid}/?__cft__[0]=AZXk2abc-def_GHI&__tn__=R]-R`;

const C1 = '1000000000000001'; // Thura Min Oo's top-level comment
const R1 = '1000000000000002'; // Snow2Rain2 → Htoo's comment
const R2 = '1000000000000003'; // Htoo → Snow2Rain2's reply (reply to a reply)
const R3 = '1000000000000004'; // Maple5521 → Htoo's comment
const C2 = '1000000000000005'; // Chai_lover🍵
const R4 = '1000000000000006'; // Back to Basics → Chai_lover🍵's comment

/** @returns {any} RawComment */
function item(index, fields) {
  return {
    index,
    ariaLabel: '',
    authorName: null,
    authorHref: null,
    permalinkHref: null,
    timeAria: null,
    timeText: null,
    text: '',
    left: 370,
    reactionLabel: null,
    truncated: false,
    attachments: [],
    ...fields,
  };
}

function dialogItems() {
  return [
    item(0, {
      ariaLabel: 'Comment by Thura Min Oo 2 days ago',
      authorName: 'Thura Min Oo',
      authorHref: userLink('100004444444444'),
      permalinkHref: commentLink(POST_ID, C1),
      timeAria: 'Sunday 11 October 2026 at 08:54',
      timeText: '2d',
      text: 'Hardly any degree exists that teaches you everything.\nIs there truly a degree like that?',
      left: 370,
      reactionLabel: '5 reactions; see who reacted to this',
    }),
    item(1, {
      ariaLabel: "Reply by Snow2Rain2 to Thura Min Oo's comment 2 days ago",
      authorName: 'Snow2Rain2',
      authorHref: userLink('100005555555555'),
      permalinkHref: commentLink(POST_ID, C1, R1),
      timeAria: 'Sunday 11 October 2026 at 10:02',
      timeText: '2d',
      text: 'ဟုတ်ပါတယ် 👍',
      left: 431,
      reactionLabel: '1 reaction; see who reacted to this',
    }),
    item(2, {
      ariaLabel: "Reply by Thura Min Oo to Snow2Rain2's reply 1 day ago",
      authorName: 'Thura Min Oo',
      authorHref: userLink('100004444444444'),
      permalinkHref: commentLink(POST_ID, C1, R2),
      timeAria: 'Monday 12 October 2026 at 07:30',
      timeText: '1d',
      text: 'Thanks!',
      left: 473,
    }),
    item(3, {
      ariaLabel: "Reply by Maple5521 to Thura Min Oo's comment 1 day ago",
      authorName: 'Maple5521',
      authorHref: userLink('100006666666666'),
      permalinkHref: commentLink(POST_ID, C1, R3),
      timeAria: null, // fall back to the relative time text
      timeText: '1d',
      text: 'Agree, "experience" matters, more than degrees',
      left: 431,
      truncated: true,
    }),
    item(4, {
      ariaLabel: 'Comment by Chai_lover🍵 5h',
      authorName: 'Chai_lover🍵',
      authorHref: userLink('100007777777777'),
      permalinkHref: commentLink(POST_ID, C2),
      timeAria: 'Tuesday 13 October 2026 at 04:00',
      timeText: '5h',
      text: 'Nice 🍵 post',
      left: 370,
      reactionLabel: '1.2K reactions',
      attachments: [
        { type: 'image', src: 'https://scontent.fbcdn.net/v/t39.30808-6/img.jpg?_nc_cat=1&oh=00_AbC&oe=67', alt: 'May be an image of text' },
        { type: 'link', href: 'https://example.com/article?id=7&fbclid=IwAR0xyz' },
        { type: 'video', href: `${BASE}/posts/${POST_ID}/?__cft__[0]=AZ&__tn__=-R` },
      ],
    }),
    item(5, {
      ariaLabel: "Reply by Back to Basics to Chai_lover🍵's comment 3h",
      authorName: 'Back to Basics',
      authorHref: 'https://www.facebook.com/back.to.basics/?__cft__[0]=AZ&__tn__=R',
      permalinkHref: commentLink(POST_ID, C2, R4),
      timeAria: 'Tuesday 13 October 2026 at 06:00',
      timeText: '3h',
      text: 'Line one\nLine two',
      left: 431,
    }),
    item(6, {
      ariaLabel: 'Comment by Anonymous participant 1h',
      authorName: 'Anonymous participant',
      text: 'No permalink here',
      left: 370,
    }),
    item(7, {
      ariaLabel: "Reply by Ko Ko to Anonymous participant's comment 30m",
      authorName: 'Ko Ko',
      text: 'Reply without permalink',
      left: 431,
    }),
  ];
}

function dialogRaw(overrides = {}) {
  return {
    pageUrl: `${BASE}/posts/${POST_ID}/`,
    pageTitle: 'Myanmar Software Engineers | Facebook',
    rootKind: 'dialog',
    extractedAt: EXTRACTED_AT,
    posts: [
      {
        permalinkHref: null, // no /posts/ link inside the dialog (we are on it)
        authorName: 'BrightOtter3141',
        authorHref: userLink('100012345678901'),
        text: 'Is a CS degree necessary?\nထင်မြင်ချက်ပေးကြပါ',
        dateText: '4 October at 18:19',
        dateAria: null,
        commentCountText: '20',
        emptyState: false,
        items: dialogItems(),
      },
    ],
    ...overrides,
  };
}

const run = (raw, opts = {}) => normalizeExtraction(raw, { savedAt: SAVED_AT, fallbackGroupSlug: G, mode: 'post', ...opts });

// ---------------------------------------------------------------------------------------------

describe('normalizeExtraction — observed dialog thread', () => {
  const { posts, comments, warnings } = run(dialogRaw());
  const byIndex = (i) => comments[i];
  const syntheticTop = `h:${POST_ID}:${djb2('Anonymous participant|No permalink here|')}`;
  const syntheticReply = `h:${POST_ID}:${djb2('Ko Ko|Reply without permalink|')}`;

  test('post record', () => {
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], {
      id: POST_ID,
      groupSlug: G,
      url: `${BASE}/posts/${POST_ID}/`,
      authorName: 'BrightOtter3141',
      authorId: '100012345678901',
      authorUrl: 'https://www.facebook.com/profile.php?id=100012345678901',
      text: 'Is a CS degree necessary?\nထင်မြင်ချက်ပေးကြပါ',
      postedAt: local(2026, 9, 4, 18, 19),
      postedAtApprox: false,
      postedAtText: '4 October at 18:19',
      commentCountExpected: 20,
      lastMode: 'post',
      firstSavedAt: SAVED_AT,
      lastSavedAt: SAVED_AT,
      lastFullScanAt: null,
      savedCommentCount: 8,
    });
  });

  test('ids: reply_comment_id ?? comment_id, synthetic h: ids without permalink', () => {
    assert.deepEqual(
      comments.map((c) => c.id),
      [C1, R1, R2, R3, C2, R4, syntheticTop, syntheticReply],
    );
    assert.match(syntheticTop, /^h:1234567890123456:[0-9a-f]+$/);
  });

  test('threadId = thread root comment id', () => {
    assert.deepEqual(
      comments.map((c) => c.threadId),
      [C1, C1, C1, C1, C2, C2, syntheticTop, syntheticTop],
    );
  });

  test('depth from indentation (370/431/473)', () => {
    assert.deepEqual(comments.map((c) => c.depth), [0, 1, 2, 1, 0, 1, 0, 1]);
  });

  test('parentId: reply-to-reply → the reply; later reply → the top-level comment', () => {
    assert.deepEqual(
      comments.map((c) => c.parentId),
      [null, C1, R1, C1, null, C2, null, syntheticTop],
    );
  });

  test('isReply', () => {
    assert.deepEqual(comments.map((c) => c.isReply), [false, true, true, true, false, true, false, true]);
  });

  test('parentId follows "to X\'s reply" when Facebook caps the indentation at depth 2 (live thread)', () => {
    // Observed on the group: Htet → Cheery (d1) → Htet's reply (d2) → Cheery replies to Htet's
    // d2 reply, drawn at d2 again. Indentation alone would make Cheery's first reply the parent.
    const T = '2000000000000001';
    const ids = ['2000000000000002', '2000000000000003', '2000000000000004', '2000000000000005'];
    const items = [
      item(0, { ariaLabel: 'Comment by Nay Lin Htike 1 week ago', authorName: 'Nay Lin Htike', permalinkHref: commentLink(POST_ID, T), left: 370 }),
      item(1, { ariaLabel: "Reply by BrightOtter3141 to Nay Lin Htike's comment 1 week ago", authorName: 'BrightOtter3141', permalinkHref: commentLink(POST_ID, T, ids[0]), left: 431 }),
      item(2, { ariaLabel: "Reply by Nay Lin Htike to BrightOtter3141's reply 1 week ago", authorName: 'Nay Lin Htike', permalinkHref: commentLink(POST_ID, T, ids[1]), left: 473 }),
      item(3, { ariaLabel: "Reply by BrightOtter3141 to Nay Lin Htike's reply 1 week ago", authorName: 'BrightOtter3141', permalinkHref: commentLink(POST_ID, T, ids[2]), left: 473 }),
      item(4, { ariaLabel: "Reply by Nay Lin Htike to BrightOtter3141's reply 1 week ago", authorName: 'Nay Lin Htike', permalinkHref: commentLink(POST_ID, T, ids[3]), left: 473 }),
    ];
    const res = run(dialogRaw({ posts: [{ ...dialogRaw().posts[0], items }] }));
    assert.deepEqual(res.comments.map((c) => c.depth), [0, 1, 2, 2, 2]);
    assert.deepEqual(res.comments.map((c) => c.parentId), [null, T, ids[0], ids[1], ids[2]]);
  });

  test('"to X\'s reply" only looks inside the reply\'s own branch', () => {
    // A (d0); X1 by X → A (d1); P → A (d1); Q "to X's reply" (d2, under P). X's reply in P's branch
    // was deleted / not loaded: Q belongs under P (pre-order), never under X1 in another branch.
    const A = '3000000000000001';
    const [X1, P, Q, X2, Q2] = ['3000000000000002', '3000000000000003', '3000000000000004', '3000000000000005', '3000000000000006'];
    const items = [
      item(0, { ariaLabel: 'Comment by Aye 1d', authorName: 'Aye', permalinkHref: commentLink(POST_ID, A), left: 370 }),
      item(1, { ariaLabel: "Reply by X to Aye's comment 1d", authorName: 'X', permalinkHref: commentLink(POST_ID, A, X1), left: 431 }),
      item(2, { ariaLabel: "Reply by Pyae to Aye's comment 1d", authorName: 'Pyae', permalinkHref: commentLink(POST_ID, A, P), left: 431 }),
      item(3, { ariaLabel: "Reply by Q to X's reply 1d", authorName: 'Q', permalinkHref: commentLink(POST_ID, A, Q), left: 473 }),
      // Same branch: X's reply is there → it is the parent; the branch head is checked too.
      item(4, { ariaLabel: "Reply by X to Pyae's reply 1d", authorName: 'X', permalinkHref: commentLink(POST_ID, A, X2), left: 473 }),
      item(5, { ariaLabel: "Reply by Q to X's reply 1d", authorName: 'Q', permalinkHref: commentLink(POST_ID, A, Q2), left: 473 }),
    ];
    const res = run(dialogRaw({ posts: [{ ...dialogRaw().posts[0], items }] }));
    assert.deepEqual(res.comments.map((c) => c.parentId), [null, A, A, P, P, X2]);
  });

  test('replyToName / replyToKind (emoji and " to " inside names)', () => {
    assert.deepEqual(
      comments.map((c) => [c.replyToName, c.replyToKind]),
      [
        [null, null],
        ['Thura Min Oo', 'comment'],
        ['Snow2Rain2', 'reply'],
        ['Thura Min Oo', 'comment'],
        [null, null],
        ['Chai_lover🍵', 'comment'],
        [null, null],
        ['Anonymous participant', 'comment'],
      ],
    );
  });

  test('createdAt from timeAria (exact) else relative timeText / aria-label (approx)', () => {
    assert.equal(byIndex(0).createdAt, local(2026, 9, 11, 8, 54));
    assert.equal(byIndex(0).createdAtApprox, false);
    assert.equal(byIndex(0).createdAtText, 'Sunday 11 October 2026 at 08:54');
    assert.equal(byIndex(0).relativeTime, '2d');

    assert.equal(byIndex(2).createdAt, local(2026, 9, 12, 7, 30));

    assert.equal(byIndex(3).createdAt, ago(DAY));
    assert.equal(byIndex(3).createdAtApprox, true);
    assert.equal(byIndex(3).createdAtText, '1d');

    // no time link at all → trailing part of the aria-label
    assert.equal(byIndex(6).createdAt, ago(HOUR));
    assert.equal(byIndex(6).createdAtApprox, true);
    assert.equal(byIndex(6).createdAtText, null);
    assert.equal(byIndex(6).relativeTime, null);
    assert.equal(byIndex(7).createdAt, ago(30 * 60e3));
  });

  test('reactionCount', () => {
    assert.deepEqual(comments.map((c) => c.reactionCount), [5, 1, 0, 0, 1200, 0, 0, 0]);
  });

  test('canonical permalinks without tracking params', () => {
    assert.equal(byIndex(0).permalink, `${BASE}/posts/${POST_ID}/?comment_id=${C1}`);
    assert.equal(byIndex(2).permalink, `${BASE}/posts/${POST_ID}/?comment_id=${C1}&reply_comment_id=${R2}`);
    assert.equal(byIndex(6).permalink, null);
  });

  test('author ids / URLs', () => {
    assert.equal(byIndex(0).authorName, 'Thura Min Oo');
    assert.equal(byIndex(0).authorId, '100004444444444');
    assert.equal(byIndex(0).authorUrl, 'https://www.facebook.com/profile.php?id=100004444444444');
    assert.equal(byIndex(4).authorName, 'Chai_lover🍵');
    assert.equal(byIndex(5).authorId, null);
    assert.equal(byIndex(5).authorUrl, 'https://www.facebook.com/back.to.basics');
    assert.equal(byIndex(6).authorId, null);
    assert.equal(byIndex(6).authorUrl, null);
  });

  test('attachments: src kept as-is, href tracking stripped', () => {
    assert.deepEqual(byIndex(4).attachments, [
      { type: 'image', src: 'https://scontent.fbcdn.net/v/t39.30808-6/img.jpg?_nc_cat=1&oh=00_AbC&oe=67', alt: 'May be an image of text' },
      { type: 'link', href: 'https://example.com/article?id=7' },
      { type: 'video', href: `${BASE}/posts/${POST_ID}/` },
    ]);
  });

  test('other fields', () => {
    const c = byIndex(3);
    assert.equal(c.postId, POST_ID);
    assert.equal(c.groupSlug, G);
    assert.equal(c.truncated, true);
    assert.equal(c.text, 'Agree, "experience" matters, more than degrees');
    assert.equal(byIndex(1).text, 'ဟုတ်ပါတယ် 👍');
    assert.deepEqual(comments.map((x) => x.order), [0, 1, 2, 3, 4, 5, 6, 7]);
    for (const x of comments) {
      assert.equal(x.firstSavedAt, SAVED_AT);
      assert.equal(x.lastSavedAt, SAVED_AT);
      assert.equal(x.missingAt, null);
      assert.deepEqual(x.previousTexts, []);
      assert.equal('_hasThread' in x, false);
    }
  });

  test('warns about synthetic ids', () => {
    assert.ok(warnings.some((w) => /2 comment\(s\).*synthetic/.test(w)), warnings.join('\n'));
  });

  test('synthetic ids are stable across runs', () => {
    const again = run(dialogRaw());
    assert.deepEqual(again.comments.map((c) => c.id), comments.map((c) => c.id));
  });
});

describe('normalizeExtraction — post id sources', () => {
  test('comment permalinks win over the page URL (and agree with the post permalink)', () => {
    const raw = dialogRaw();
    raw.posts[0].permalinkHref = `${BASE}/posts/${POST_ID}/?__cft__[0]=AZ&__tn__=%2CO%2CP-R`;
    raw.pageUrl = `${BASE}/posts/999/`;
    assert.equal(run(raw).posts[0].id, POST_ID);
  });

  test('from comment permalinks when the post has no permalink', () => {
    const raw = dialogRaw({ pageUrl: `${BASE}/`, rootKind: 'feed' });
    const { posts } = run(raw);
    assert.equal(posts[0].id, POST_ID);
    assert.equal(posts[0].groupSlug, G);
  });

  test('from pageUrl only for dialog/main roots', () => {
    const post = { permalinkHref: null, authorName: 'A', authorHref: null, text: 'x', dateText: null, dateAria: null, commentCountText: null, emptyState: true, items: [] };
    for (const rootKind of ['dialog', 'main']) {
      const { posts, warnings } = run({ pageUrl: `${BASE}/posts/333/`, pageTitle: '', rootKind, extractedAt: EXTRACTED_AT, posts: [post] });
      assert.equal(posts.length, 1, rootKind);
      assert.equal(posts[0].id, '333');
      assert.equal(posts[0].commentCountExpected, null);
      assert.deepEqual(warnings, []);
    }
    const feed = run({ pageUrl: `${BASE}/posts/333/`, pageTitle: '', rootKind: 'feed', extractedAt: EXTRACTED_AT, posts: [post] });
    assert.equal(feed.posts.length, 0);
    assert.ok(feed.warnings.some((w) => /Skipped post #1 by A/.test(w)), feed.warnings.join('\n'));
  });

  test('a non-group id source (story_fbid) is never filed under the fallback group', () => {
    const post = { permalinkHref: null, authorName: null, authorHref: null, text: '', dateText: null, dateAria: null, commentCountText: null, emptyState: true, items: [] };
    const raw = { pageUrl: 'https://www.facebook.com/permalink.php?story_fbid=999&id=123', pageTitle: '', rootKind: 'main', extractedAt: EXTRACTED_AT, posts: [post] };
    for (const out of [run(raw), normalizeExtraction(raw, { savedAt: SAVED_AT, mode: 'quick' })]) {
      assert.equal(out.posts[0].id, '999');
      assert.equal(out.posts[0].groupSlug, null);
      assert.equal(out.posts[0].url, 'https://www.facebook.com/permalink.php?story_fbid=999&id=123');
    }
  });

  test('home feed quick save: a friend\'s post (permalink.php comment links) keeps its own URLs', () => {
    const href = (cid) => `https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100055&comment_id=${cid}&__cft__[0]=AZ&__tn__=R]-R`;
    const raw = {
      pageUrl: 'https://www.facebook.com/',
      pageTitle: 'Facebook',
      rootKind: 'feed',
      extractedAt: EXTRACTED_AT,
      posts: [
        {
          permalinkHref: null,
          authorName: 'A Friend',
          authorHref: null,
          text: 'Weekend!',
          dateText: '2h',
          dateAria: null,
          commentCountText: '1',
          emptyState: false,
          items: [item(0, { ariaLabel: 'Comment by B 1h', authorName: 'B', permalinkHref: href('777'), timeText: '1h', text: 'nice' })],
        },
      ],
    };
    const { posts, comments } = run(raw, { mode: 'quick' }); // run() passes fallbackGroupSlug G
    assert.equal(posts[0].id, 'pfbid02abc');
    assert.equal(posts[0].groupSlug, null, 'not filed under the default group');
    assert.equal(posts[0].url, 'https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100055');
    assert.equal(comments[0].groupSlug, null);
    assert.equal(comments[0].permalink, 'https://www.facebook.com/permalink.php?story_fbid=pfbid02abc&id=100055&comment_id=777');
  });

  test('a link to another group post inside an open post never becomes its id', () => {
    // The dialog has no own /posts/ link; a body link or shared post pointing elsewhere must not win.
    const raw = dialogRaw();
    raw.posts[0].permalinkHref = `${BASE}/posts/1111111111111111/?__cft__[0]=AZ`;
    const { posts, comments, warnings } = run(raw);
    assert.equal(posts[0].id, POST_ID);
    assert.equal(posts[0].url, `${BASE}/posts/${POST_ID}/`);
    assert.ok(comments.every((c) => c.postId === POST_ID));
    assert.equal(comments[0].permalink, `${BASE}/posts/${POST_ID}/?comment_id=${C1}`);
    assert.ok(warnings.some((w) => /ignored a link to another post \(1111111111111111\)/.test(w)), warnings.join('\n'));

    // Without comment permalinks the page URL (open post) still beats the stray link.
    const empty = dialogRaw();
    empty.posts[0].items = [];
    empty.posts[0].permalinkHref = `${BASE}/posts/1111111111111111/`;
    const out = run(empty);
    assert.equal(out.posts[0].id, POST_ID);
    assert.ok(out.warnings.some((w) => /ignored a link to another post/.test(w)));
  });

  test('feed: comment permalinks beat a post link that points elsewhere; the majority wins', () => {
    const raw = dialogRaw({ pageUrl: `${BASE}/`, rootKind: 'feed' });
    raw.posts[0].permalinkHref = `${BASE}/posts/5555/`;
    // One stray comment link to another post is outvoted by the others.
    raw.posts[0].items[7] = { ...raw.posts[0].items[7], permalinkHref: commentLink('5555', '42') };
    const { posts, warnings } = run(raw);
    assert.equal(posts[0].id, POST_ID);
    assert.ok(warnings.some((w) => /ignored a link to another post \(5555\)/.test(w)));
  });

  test('the post permalink decides when nothing else identifies the post', () => {
    const post = { permalinkHref: `${BASE}/posts/4444/?__cft__[0]=AZ`, authorName: null, authorHref: null, text: 'x', dateText: '1h', dateAria: null, commentCountText: null, emptyState: false, items: [] };
    const { posts, warnings } = run({ pageUrl: `${BASE}/`, pageTitle: '', rootKind: 'feed', extractedAt: EXTRACTED_AT, posts: [post] });
    assert.equal(posts[0].id, '4444');
    assert.deepEqual(warnings, []);
  });

  test('empty extraction → warning, nothing else', () => {
    const out = run({ pageUrl: 'https://www.facebook.com/', pageTitle: '', rootKind: 'none', extractedAt: EXTRACTED_AT, posts: [] });
    assert.deepEqual(out.posts, []);
    assert.deepEqual(out.comments, []);
    assert.equal(out.warnings.length, 1);
  });
});

describe('normalizeExtraction — feed with multiple posts', () => {
  const raw = {
    pageUrl: `${BASE}?sorting_setting=CHRONOLOGICAL`,
    pageTitle: 'Myanmar Software Engineers | Facebook',
    rootKind: 'feed',
    extractedAt: EXTRACTED_AT,
    posts: [
      {
        permalinkHref: `${BASE}/posts/111/?__cft__[0]=AZ&__tn__=%2CO%2CP-R`,
        authorName: 'Aung Aung',
        authorHref: userLink('100000000000111'),
        text: 'First post',
        dateText: '5h',
        dateAria: null,
        commentCountText: '1.2K',
        emptyState: false,
        items: [
          item(0, {
            ariaLabel: 'Comment by Mya Mya 1h',
            authorName: 'Mya Mya',
            permalinkHref: commentLink('111', '9001'),
            timeAria: 'Tuesday 13 October 2026 at 08:00',
            timeText: '1h',
            text: 'preview comment',
            left: 0, // not laid out
          }),
        ],
      },
      {
        // no post permalink (lazy href) → id from comment permalinks
        permalinkHref: null,
        authorName: 'Ko Ko',
        authorHref: userLink('100000000000222'),
        text: 'Second post',
        dateText: '1d',
        dateAria: null,
        commentCountText: '1,234',
        emptyState: false,
        items: [
          item(0, { ariaLabel: 'Comment by A 2h', authorName: 'A', permalinkHref: commentLink('222', '9101'), timeText: '2h', text: 'top', left: 300 }),
          item(1, { ariaLabel: "Reply by B to A's comment 1h", authorName: 'B', permalinkHref: commentLink('222', '9101', '9102'), timeText: '1h', text: 'reply', left: 300 }),
          item(2, { ariaLabel: "Reply by A to B's reply 1h", authorName: 'A', permalinkHref: commentLink('222', '9101', '9103'), timeText: '1h', text: 'reply to reply', left: 300 }),
        ],
      },
      {
        // no permalink anywhere → skipped (pageUrl is not used for feeds)
        permalinkHref: null,
        authorName: 'Nobody',
        authorHref: null,
        text: 'Third post',
        dateText: null,
        dateAria: null,
        commentCountText: null,
        emptyState: false,
        items: [item(0, { ariaLabel: 'Comment by Z 1h', authorName: 'Z', text: 'lost', left: 300 })],
      },
    ],
  };
  const { posts, comments, warnings } = run(raw, { mode: 'crawl' });

  test('one record per identifiable post', () => {
    assert.deepEqual(posts.map((p) => p.id), ['111', '222']);
    assert.deepEqual(posts.map((p) => p.url), [`${BASE}/posts/111/`, `${BASE}/posts/222/`]);
    assert.deepEqual(posts.map((p) => p.lastMode), ['crawl', 'crawl']);
    assert.equal(warnings.filter((w) => /Skipped post #3 by Nobody/.test(w)).length, 1);
  });

  test('relative post dates and comment counts', () => {
    assert.equal(posts[0].postedAt, ago(5 * HOUR));
    assert.equal(posts[0].postedAtApprox, true);
    assert.equal(posts[0].postedAtText, '5h');
    assert.equal(posts[0].commentCountExpected, 1200);
    assert.equal(posts[1].commentCountExpected, 1234);
  });

  test('comments are attached to their posts', () => {
    assert.deepEqual(comments.map((c) => [c.postId, c.id]), [
      ['111', '9001'],
      ['222', '9101'],
      ['222', '9102'],
      ['222', '9103'],
    ]);
  });

  test('all-left-equal / not-laid-out fallback depth', () => {
    assert.deepEqual(comments.map((c) => c.depth), [0, 0, 1, 2]);
    assert.deepEqual(comments.map((c) => c.parentId), [null, null, '9101', '9102']);
    assert.deepEqual(comments.map((c) => c.threadId), ['9001', '9101', '9101', '9101']);
  });
});

describe('normalizeExtraction — depth edge cases', () => {
  const wrap = (items) => ({
    pageUrl: `${BASE}/posts/${POST_ID}/`,
    pageTitle: '',
    rootKind: 'dialog',
    extractedAt: EXTRACTED_AT,
    posts: [{ permalinkHref: null, authorName: null, authorHref: null, text: '', dateText: null, dateAria: null, commentCountText: null, emptyState: false, items }],
  });

  test('sub-pixel differences in left belong to the same level', () => {
    const { comments } = run(wrap([
      item(0, { ariaLabel: 'Comment by A 1h', authorName: 'A', permalinkHref: commentLink(POST_ID, '1'), left: 370 }),
      item(1, { ariaLabel: "Reply by B to A's comment 1h", authorName: 'B', permalinkHref: commentLink(POST_ID, '1', '2'), left: 432 }),
      item(2, { ariaLabel: 'Comment by C 1h', authorName: 'C', permalinkHref: commentLink(POST_ID, '3'), left: 371 }),
      item(3, { ariaLabel: "Reply by D to C's comment 1h", authorName: 'D', permalinkHref: commentLink(POST_ID, '3', '4'), left: 431 }),
    ]));
    assert.deepEqual(comments.map((c) => c.depth), [0, 1, 0, 1]);
    assert.deepEqual(comments.map((c) => c.parentId), [null, '1', null, '3']);
  });

  test('clamping: top-level is always 0, replies at least 1', () => {
    const { comments } = run(wrap([
      item(0, { ariaLabel: "Reply by B to A's comment 1h", authorName: 'B', permalinkHref: commentLink(POST_ID, '1', '2'), left: 370 }),
      item(1, { ariaLabel: 'Comment by C 1h', authorName: 'C', permalinkHref: commentLink(POST_ID, '3'), left: 431 }),
    ]));
    assert.deepEqual(comments.map((c) => c.depth), [1, 0]);
    // parent unknown in DOM → thread root id from the permalink
    assert.equal(comments[0].parentId, '1');
  });

  test('reply detected from aria-label without permalink; author parsed from aria-label', () => {
    const { comments } = run(wrap([
      item(0, { ariaLabel: 'Comment by Mg Mg 2h', authorName: 'Mg Mg', text: 'root', left: 0 }),
      item(1, { ariaLabel: "Reply by Aye Aye to Mg Mg's reply 2h", authorName: null, text: 'nested', left: 0 }),
    ]));
    assert.equal(comments[1].isReply, true);
    assert.equal(comments[1].authorName, 'Aye Aye');
    assert.equal(comments[1].replyToName, 'Mg Mg');
    assert.equal(comments[1].replyToKind, 'reply');
    assert.equal(comments[1].depth, 2);
    assert.equal(comments[1].threadId, comments[0].id);
    assert.equal(comments[1].parentId, comments[0].id);
  });

  test('replied-to name containing " to "', () => {
    const { comments } = run(wrap([
      item(0, { ariaLabel: "Reply by Su Su to Back to Basics's comment 1h", authorName: 'Su Su', permalinkHref: commentLink(POST_ID, '1', '2'), left: 431 }),
    ]));
    assert.equal(comments[0].replyToName, 'Back to Basics');
    assert.equal(comments[0].replyToKind, 'comment');
  });

  test('curly apostrophe in aria-label', () => {
    const { comments } = run(wrap([
      item(0, { ariaLabel: 'Reply by Su Su to Ko Ko’s reply 1h', authorName: 'Su Su', permalinkHref: commentLink(POST_ID, '1', '2'), left: 431 }),
    ]));
    assert.equal(comments[0].replyToName, 'Ko Ko');
    assert.equal(comments[0].replyToKind, 'reply');
  });

  test('identical comments without permalinks get distinct ids', () => {
    const same = { ariaLabel: 'Comment by A 1h', authorName: 'A', text: '+1', timeText: '1h', left: 370 };
    const { comments } = run(wrap([item(0, same), item(1, same)]));
    assert.equal(comments.length, 2);
    assert.notEqual(comments[0].id, comments[1].id);
    assert.equal(comments[1].id, `${comments[0].id}~2`);
  });
});

describe('parseCount', () => {
  test('formats', () => {
    assert.equal(parseCount('5 reactions; see who reacted to this'), 5);
    assert.equal(parseCount('1 reaction; see who reacted to this'), 1);
    assert.equal(parseCount('1.2K reactions'), 1200);
    assert.equal(parseCount('1,234'), 1234);
    assert.equal(parseCount('3M'), 3_000_000);
    assert.equal(parseCount('20'), 20);
    assert.equal(parseCount('See who reacted'), null);
    assert.equal(parseCount(null), null);
  });
});

// ---------------------------------------------------------------------------------------------
// React-data fallbacks (fiber fields): markup variants where comments have no permalink and/or
// posts no header link (SPEC §1 live facts, §5).
// ---------------------------------------------------------------------------------------------

describe('normalizeExtraction: React data (fiber) fallbacks', () => {
  /** Comments without permalinks, identified only by React data. Aria-labels are not English. */
  function fiberItems(postId = POST_ID) {
    const fiber = (index, own, uid, name, left, extra = {}) =>
      item(index, {
        ariaLabel: `Kommentar von ${name}`,
        timeAria: null,
        timeText: '2 Std.',
        text: `text ${index}`,
        left,
        fiberCommentId: own,
        fiberPostId: postId,
        fiberAuthorId: uid,
        fiberAuthorName: name,
        ...extra,
      });
    return [
      fiber(0, C1, '100004444444444', 'Thura Min Oo', 370),
      fiber(1, R1, '100005555555555', 'Snow2Rain2', 431),
      fiber(2, R2, '100004444444444', 'Thura Min Oo', 473),
      fiber(3, C2, '100006666666666', 'Chai_lover🍵', 370),
      fiber(4, R4, '100007777777777', 'Back to Basics', 431),
    ];
  }
  const dialogRaw = (items, extra = {}) => ({
    pageUrl: `${BASE}/posts/${POST_ID}/`,
    pageTitle: 'x',
    rootKind: 'dialog',
    extractedAt: EXTRACTED_AT,
    posts: [{ permalinkHref: null, authorName: 'Op', authorHref: null, text: 'post', dateText: null, dateAria: null, commentCountText: '5', emptyState: false, items, ...extra }],
  });

  test('comment ids, replies (by indentation), threads and canonical permalinks', () => {
    const { comments, warnings } = normalizeExtraction(dialogRaw(fiberItems()), { savedAt: SAVED_AT, fallbackGroupSlug: G });
    assert.deepEqual(comments.map((c) => c.id), [C1, R1, R2, C2, R4]);
    assert.deepEqual(comments.map((c) => c.isReply), [false, true, true, false, true]);
    assert.deepEqual(comments.map((c) => c.depth), [0, 1, 2, 0, 1]);
    assert.deepEqual(comments.map((c) => c.threadId), [C1, C1, C1, C2, C2]);
    assert.deepEqual(comments.map((c) => c.parentId), [null, C1, R1, null, C2]);
    assert.equal(comments[0].permalink, `${BASE}/posts/${POST_ID}/?comment_id=${C1}`);
    assert.equal(comments[2].permalink, `${BASE}/posts/${POST_ID}/?comment_id=${C1}&reply_comment_id=${R2}`);
    assert.ok(!warnings.some((w) => /synthetic/.test(w)));
    assert.ok(!warnings.some((w) => /page data/.test(w)), 'the page URL confirms the post id');
  });

  test('authorId/authorName/authorUrl from React data when there is no author link', () => {
    const { comments } = normalizeExtraction(dialogRaw(fiberItems()), { savedAt: SAVED_AT, fallbackGroupSlug: G });
    assert.equal(comments[0].authorName, 'Thura Min Oo');
    assert.equal(comments[0].authorId, '100004444444444');
    assert.equal(comments[0].authorUrl, 'https://www.facebook.com/profile.php?id=100004444444444');
    assert.equal(comments[3].authorName, 'Chai_lover🍵');
    // A link (and its text) still wins over React data.
    const items = fiberItems();
    items[0].authorName = 'Thura (link)';
    items[0].authorHref = userLink('100009999999999');
    const r = normalizeExtraction(dialogRaw(items), { savedAt: SAVED_AT, fallbackGroupSlug: G });
    assert.equal(r.comments[0].authorName, 'Thura (link)');
    assert.equal(r.comments[0].authorId, '100009999999999');
    // React data's name comes before the aria-label parse.
    const noName = fiberItems();
    noName[1].ariaLabel = "Reply by Someone Else to Thura Min Oo's comment 2 days ago";
    assert.equal(normalizeExtraction(dialogRaw(noName), { savedAt: SAVED_AT }).comments[1].authorName, 'Snow2Rain2');
  });

  test('a permalink id wins over the React id; non-numeric React values are ignored', () => {
    const items = fiberItems();
    items[0].permalinkHref = commentLink(POST_ID, '1000000000000099');
    items[1].fiberCommentId = 'not-a-number';
    items[1].fiberAuthorId = 'pfbid0abc';
    const { comments } = normalizeExtraction(dialogRaw(items), { savedAt: SAVED_AT, fallbackGroupSlug: G });
    assert.equal(comments[0].id, '1000000000000099');
    assert.match(comments[1].id, /^h:/, 'falls back to a synthetic id');
    assert.equal(comments[1].authorId, null);
  });

  test('post id order: comment links → comment React ids → page URL → post link → post React id', () => {
    const other = '7777777777777777';
    const opts = { savedAt: SAVED_AT, fallbackGroupSlug: G };
    // Comment React ids beat the page URL.
    const r1 = normalizeExtraction(dialogRaw(fiberItems(other)), opts);
    assert.equal(r1.posts[0].id, other);
    assert.ok(r1.warnings.some((w) => w.startsWith(`Post ${other}: no link names this post`)));
    // One vote per comment (its link's post id, else its React id): the majority decides.
    const items = fiberItems(other);
    items[0].permalinkHref = commentLink(POST_ID, C1);
    items[1].permalinkHref = commentLink(POST_ID, C1, R1);
    items[2].permalinkHref = commentLink(POST_ID, C1, R2);
    assert.equal(normalizeExtraction(dialogRaw(items), opts).posts[0].id, POST_ID);
    // Feed post: no comments, no link → the post's React id, slug from the page URL.
    const feedRaw = {
      pageUrl: `https://www.facebook.com/groups/${G}/?sorting_setting=CHRONOLOGICAL`,
      pageTitle: 'x',
      rootKind: 'feed',
      extractedAt: EXTRACTED_AT,
      posts: [
        { permalinkHref: null, authorName: 'Op', authorHref: null, text: 'a', dateText: '5h', dateAria: null, commentCountText: null, emptyState: false, fiberPostId: other, items: [] },
        { permalinkHref: `${BASE}/posts/${POST_ID}/?__cft__[0]=x`, authorName: 'Op', authorHref: null, text: 'b', dateText: '6h', dateAria: null, commentCountText: null, emptyState: false, fiberPostId: other, items: [] },
        { permalinkHref: null, authorName: 'Op', authorHref: null, text: 'c', dateText: '7h', dateAria: null, commentCountText: null, emptyState: false, fiberPostId: 'abc', items: [] },
      ],
    };
    const r2 = normalizeExtraction(feedRaw, { savedAt: SAVED_AT, fallbackGroupSlug: null });
    assert.deepEqual(r2.posts.map((p) => p.id), [other, POST_ID]);
    assert.equal(r2.posts[0].groupSlug, G);
    assert.equal(r2.posts[0].url, `${BASE}/posts/${other}/`);
    assert.ok(r2.warnings.some((w) => /^Skipped post #3/.test(w)), 'a non-numeric React id is not an id');
    // Without any slug the post still gets saved (url null), never filed under a wrong group.
    const r3 = normalizeExtraction({ ...feedRaw, pageUrl: 'https://www.facebook.com/', posts: [feedRaw.posts[0]] }, { savedAt: SAVED_AT });
    assert.equal(r3.posts[0].groupSlug, null);
    assert.equal(r3.posts[0].url, null);
  });

  test('one stray comment link never outvotes the other comments\' React ids', () => {
    // A link to another post's comment (e.g. pasted in a comment) taken for item 1's permalink.
    const stray = '1777000000000001';
    const items = fiberItems();
    items[1].permalinkHref = commentLink(stray, '4242000000000001');
    const opts = { savedAt: SAVED_AT, fallbackGroupSlug: G };
    const r = normalizeExtraction(dialogRaw(items), opts);
    assert.equal(r.posts[0].id, POST_ID);
    assert.equal(r.posts[0].url, `${BASE}/posts/${POST_ID}/`);
    assert.ok(r.comments.every((c) => c.postId === POST_ID));
    assert.ok(r.comments.every((c) => !(c.permalink || '').includes(`/posts/${stray}/`)), 'no permalink names the other post');
    // Without a page URL (feed quick save) the React majority still wins over the single link.
    const feed = { ...dialogRaw(items), pageUrl: `https://www.facebook.com/groups/${G}/`, rootKind: 'feed' };
    const f = normalizeExtraction(feed, opts);
    assert.equal(f.posts[0].id, POST_ID);
    assert.ok(f.warnings.some((w) => w.startsWith(`Post ${POST_ID}: no link names this post`)));
    // Links that are the majority still win, with their URL's parts.
    const many = fiberItems(stray);
    many[0].permalinkHref = commentLink(POST_ID, C1);
    many[1].permalinkHref = commentLink(POST_ID, C1, R1);
    many[2].permalinkHref = commentLink(POST_ID, C1, R2);
    const m = normalizeExtraction({ ...dialogRaw(many), pageUrl: 'https://www.facebook.com/' }, opts);
    assert.equal(m.posts[0].id, POST_ID);
    assert.ok(!m.warnings.some((w) => /page data/.test(w)), 'confirmed by comment links');
  });
});
