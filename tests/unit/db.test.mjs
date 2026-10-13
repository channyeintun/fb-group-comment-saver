// Unit tests for src/lib/db.js (SPEC §6) using fake-indexeddb.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { DB_NAME } from '../../src/lib/constants.js';
import {
  openDb,
  savePostBundle,
  listPosts,
  getPost,
  getComments,
  getAllComments,
  searchComments,
  getStats,
  deletePost,
  clearAll,
  postsScannedSince,
} from '../../src/lib/db.js';

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-02T10:00:00.000Z';
const T3 = '2026-10-03T10:00:00.000Z';
const T4 = '2026-10-04T10:00:00.000Z';

/** Fresh, empty database for every test (deleteDatabase must not be blocked by our cached connection). */
beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(undefined);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase blocked: open connection did not close on versionchange'));
  });
});

/** PostRecord as produced by normalize.js. */
function makePost(id, overrides = {}) {
  return {
    id,
    groupSlug: 'testgroup',
    url: `https://www.facebook.com/groups/testgroup/posts/${id}/`,
    authorName: 'Post Author',
    authorId: '100',
    authorUrl: 'https://www.facebook.com/profile.php?id=100',
    text: 'Post body text',
    postedAt: '2026-09-30T08:00:00.000Z',
    postedAtApprox: false,
    postedAtText: '30 September at 15:30',
    commentCountExpected: 3,
    lastMode: 'post',
    firstSavedAt: T1,
    lastSavedAt: T1,
    lastFullScanAt: null,
    savedCommentCount: 0,
    ...overrides,
  };
}

/** CommentRecord as produced by normalize.js. */
function makeComment(postId, id, overrides = {}) {
  return {
    id,
    postId,
    groupSlug: 'testgroup',
    threadId: id,
    parentId: null,
    depth: 0,
    isReply: false,
    replyToName: null,
    replyToKind: null,
    authorName: `Author ${id}`,
    authorId: null,
    authorUrl: null,
    text: `Comment ${id}`,
    truncated: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    createdAtApprox: false,
    createdAtText: 'Thursday 1 October 2026 at 16:30',
    relativeTime: '1d',
    reactionCount: 0,
    attachments: [],
    permalink: `https://www.facebook.com/groups/testgroup/posts/${postId}/?comment_id=${id}`,
    order: 0,
    firstSavedAt: T1,
    lastSavedAt: T1,
    missingAt: null,
    previousTexts: [],
    ...overrides,
  };
}

/** Three comments for post `postId`, all stamped with `savedAt`. */
function threeComments(postId, savedAt = T1) {
  return ['c1', 'c2', 'c3'].map((id, i) =>
    makeComment(postId, `${postId}-${id}`, { order: i, firstSavedAt: savedAt, lastSavedAt: savedAt }),
  );
}

/** Re-stamp records as normalize would for a later save. */
function restamp(records, savedAt) {
  return records.map((r) => ({ ...r, firstSavedAt: savedAt, lastSavedAt: savedAt }));
}

test('openDb creates the schema and caches the connection', async () => {
  const db = await openDb();
  assert.equal(db.name, DB_NAME);
  assert.deepEqual([...db.objectStoreNames].sort(), ['comments', 'posts']);
  assert.equal(await openDb(), db, 'same realm → same cached connection');

  const tx = db.transaction(['posts', 'comments'], 'readonly');
  const posts = tx.objectStore('posts');
  const comments = tx.objectStore('comments');
  assert.equal(posts.keyPath, 'id');
  assert.equal(comments.keyPath, 'id');
  assert.deepEqual([...posts.indexNames].sort(), ['groupSlug', 'lastSavedAt']);
  assert.deepEqual([...comments.indexNames].sort(), ['authorName', 'lastSavedAt', 'postId']);
});

test('openDb reopens when the IndexedDB factory changes', async () => {
  const original = globalThis.indexedDB;
  const first = await openDb();
  try {
    globalThis.indexedDB = new IDBFactory();
    const second = await openDb();
    assert.notEqual(second, first);
    assert.deepEqual(await listPosts(), []);
  } finally {
    globalThis.indexedDB = original;
  }
  assert.equal(await openDb(), first);
});

test('a cached connection that was closed is transparently reopened', async () => {
  await savePostBundle(makePost('p1'), [], { now: T1 });
  const db = await openDb();
  db.close(); // close() fires no event, so the cache still holds the dead connection
  assert.equal((await listPosts()).length, 1);
  assert.notEqual(await openDb(), db);
});

test('insert: new post and comments', async () => {
  const post = makePost('p1');
  const res = await savePostBundle(post, threeComments('p1'), { fullScan: false, now: T1 });
  assert.deepEqual(res, { inserted: 3, updated: 0, unchanged: 0, markedMissing: 0, total: 3 });

  const stored = await getPost('p1');
  assert.equal(stored.savedCommentCount, 3);
  assert.equal(stored.firstSavedAt, T1);
  assert.equal(stored.lastSavedAt, T1);
  assert.equal(stored.lastFullScanAt, null);
  assert.equal(stored.text, 'Post body text');

  const comments = await getComments('p1');
  assert.deepEqual(
    comments.map((c) => c.id),
    ['p1-c1', 'p1-c2', 'p1-c3'],
  );
  for (const c of comments) {
    assert.equal(c.missingAt, null);
    assert.deepEqual(c.previousTexts, []);
    assert.equal(c.firstSavedAt, T1);
  }
  assert.equal(await getPost('nope'), undefined);
});

test('fullScan on insert sets lastFullScanAt', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1'), { fullScan: true, now: T1 });
  assert.equal((await getPost('p1')).lastFullScanAt, T1);
});

test('re-save unchanged → unchanged counts, lastSavedAt advances', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1', T1), { fullScan: true, now: T1 });
  const res = await savePostBundle(
    makePost('p1', { firstSavedAt: T2, lastSavedAt: T2 }),
    threeComments('p1', T2),
    { fullScan: true, now: T2 },
  );
  assert.deepEqual(res, { inserted: 0, updated: 0, unchanged: 3, markedMissing: 0, total: 3 });

  const comments = await getComments('p1');
  for (const c of comments) {
    assert.equal(c.lastSavedAt, T2);
    assert.equal(c.firstSavedAt, T1);
  }
  const post = await getPost('p1');
  assert.equal(post.lastSavedAt, T2);
  assert.equal(post.lastFullScanAt, T2);
});

test('edited text → previousTexts keeps old version, counted as updated', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1', T1), { fullScan: false, now: T1 });
  const incoming = threeComments('p1', T2);
  incoming[1] = { ...incoming[1], text: 'Edited text' };
  const res = await savePostBundle(makePost('p1', { lastSavedAt: T2 }), incoming, { fullScan: false, now: T2 });
  assert.deepEqual(res, { inserted: 0, updated: 1, unchanged: 2, markedMissing: 0, total: 3 });

  const c2 = (await getComments('p1')).find((c) => c.id === 'p1-c2');
  assert.equal(c2.text, 'Edited text');
  assert.deepEqual(c2.previousTexts, [{ text: 'Comment p1-c2', savedAt: T1 }]);
  assert.equal(c2.firstSavedAt, T1);

  // A second edit appends to the history.
  const again = threeComments('p1', T3);
  again[1] = { ...again[1], text: 'Edited twice' };
  await savePostBundle(makePost('p1', { lastSavedAt: T3 }), again, { fullScan: false, now: T3 });
  const c2b = (await getComments('p1')).find((c) => c.id === 'p1-c2');
  assert.equal(c2b.text, 'Edited twice');
  assert.deepEqual(c2b.previousTexts, [
    { text: 'Comment p1-c2', savedAt: T1 },
    { text: 'Edited text', savedAt: T2 },
  ]);
});

test('empty incoming text never overwrites stored text', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1', T1), { now: T1 });
  const incoming = threeComments('p1', T2);
  incoming[0] = { ...incoming[0], text: '' };
  const res = await savePostBundle(makePost('p1'), incoming, { now: T2 });
  assert.equal(res.unchanged, 3);
  const c1 = (await getComments('p1'))[0];
  assert.equal(c1.text, 'Comment p1-c1');
  assert.deepEqual(c1.previousTexts, []);
});

test('truncated incoming that is a prefix keeps the full stored text', async () => {
  const full = 'This is a long comment with a lot of detail that Facebook truncates in previews.';
  await savePostBundle(makePost('p1'), [makeComment('p1', 'c1', { text: full })], { now: T1 });

  for (const shown of ['This is a long comment with a lot…', 'This is a long comment with a lot ...', 'This is a long']) {
    const res = await savePostBundle(
      makePost('p1'),
      [makeComment('p1', 'c1', { text: shown, truncated: true, lastSavedAt: T2 })],
      { now: T2 },
    );
    assert.deepEqual(res, { inserted: 0, updated: 0, unchanged: 1, markedMissing: 0, total: 1 }, shown);
    const [c] = await getComments('p1');
    assert.equal(c.text, full);
    assert.equal(c.truncated, false);
    assert.deepEqual(c.previousTexts, []);
  }

  // A truncated text that is NOT a prefix is an edit.
  await savePostBundle(
    makePost('p1'),
    [makeComment('p1', 'c1', { text: 'Completely different…', truncated: true, lastSavedAt: T3 })],
    { now: T3 },
  );
  const [edited] = await getComments('p1');
  assert.equal(edited.text, 'Completely different…');
  assert.equal(edited.truncated, true);
  assert.deepEqual(edited.previousTexts, [{ text: full, savedAt: T2 }]);
});

test('full text replacing a stored truncated text is not recorded as an edit', async () => {
  await savePostBundle(
    makePost('p1'),
    [makeComment('p1', 'c1', { text: 'Start of a long comment…', truncated: true })],
    { now: T1 },
  );
  const res = await savePostBundle(
    makePost('p1'),
    [makeComment('p1', 'c1', { text: 'Start of a long comment and the rest of it.', lastSavedAt: T2 })],
    { now: T2 },
  );
  assert.equal(res.updated, 1);
  const [c] = await getComments('p1');
  assert.equal(c.text, 'Start of a long comment and the rest of it.');
  assert.equal(c.truncated, false);
  assert.deepEqual(c.previousTexts, []);
});

test('fullScan marks unseen comments missing (never deletes); quick save never marks', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1', T1), { fullScan: true, now: T1 });

  // Quick save with only 1 visible comment: nothing is marked.
  const quick = await savePostBundle(makePost('p1'), threeComments('p1', T2).slice(0, 1), {
    fullScan: false,
    now: T2,
  });
  assert.deepEqual(quick, { inserted: 0, updated: 0, unchanged: 1, markedMissing: 0, total: 3 });
  assert.ok((await getComments('p1')).every((c) => c.missingAt === null));

  // Full scan without c3 → c3 marked missing, kept in the store.
  const full = await savePostBundle(makePost('p1'), threeComments('p1', T3).slice(0, 2), {
    fullScan: true,
    now: T3,
  });
  assert.deepEqual(full, { inserted: 0, updated: 0, unchanged: 2, markedMissing: 1, total: 3 });
  const comments = await getComments('p1');
  assert.equal(comments.length, 3);
  const c3 = comments.find((c) => c.id === 'p1-c3');
  assert.equal(c3.missingAt, T3);
  assert.equal(c3.lastSavedAt, T1, 'missing comment is not re-stamped');
  assert.equal((await getPost('p1')).savedCommentCount, 3);

  // Already-missing comments are not counted again.
  const again = await savePostBundle(makePost('p1'), threeComments('p1', T4).slice(0, 2), {
    fullScan: true,
    now: T4,
  });
  assert.equal(again.markedMissing, 0);
  assert.equal((await getComments('p1')).find((c) => c.id === 'p1-c3').missingAt, T3);
});

test('re-appearing comment clears missingAt and counts as updated', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1', T1), { fullScan: true, now: T1 });
  await savePostBundle(makePost('p1'), threeComments('p1', T2).slice(0, 2), { fullScan: true, now: T2 });
  assert.equal((await getComments('p1')).find((c) => c.id === 'p1-c3').missingAt, T2);

  // Seen again by a quick save (fullScan false) → cleared as well.
  const res = await savePostBundle(makePost('p1'), threeComments('p1', T3), { fullScan: false, now: T3 });
  assert.deepEqual(res, { inserted: 0, updated: 1, unchanged: 2, markedMissing: 0, total: 3 });
  const c3 = (await getComments('p1')).find((c) => c.id === 'p1-c3');
  assert.equal(c3.missingAt, null);
  assert.equal(c3.lastSavedAt, T3);
});

test('comment order: a partial save never renumbers a fully scanned post', async () => {
  // Full scan in thread pre-order: c1, its reply r1, then c2.
  const full = [
    makeComment('p1', 'c1', { order: 0 }),
    makeComment('p1', 'r1', { order: 1, depth: 1, isReply: true, threadId: 'c1', parentId: 'c1' }),
    makeComment('p1', 'c2', { order: 2 }),
  ];
  await savePostBundle(makePost('p1'), full, { fullScan: true, now: T1 });

  // Quick save with the replies collapsed numbers c2 as 1, which would sort it before r1.
  const quick = [makeComment('p1', 'c1', { order: 0 }), makeComment('p1', 'c2', { order: 1, reactionCount: 4 })];
  const res = await savePostBundle(makePost('p1', { lastMode: 'quick' }), quick, { fullScan: false, now: T2 });
  assert.deepEqual(res, { inserted: 0, updated: 1, unchanged: 1, markedMissing: 0, total: 3 });
  let comments = await getComments('p1');
  assert.deepEqual(comments.map((c) => `${c.id}:${c.order}`), ['c1:0', 'r1:1', 'c2:2'], 'stored order kept');
  assert.equal(comments.find((c) => c.id === 'c2').reactionCount, 4, 'other fields still merge');

  // The next full scan renumbers (a new comment c0 appeared first).
  const rescan = [makeComment('p1', 'c0', { order: 0 }), ...full.map((c) => ({ ...c, order: c.order + 1 }))];
  await savePostBundle(makePost('p1'), rescan, { fullScan: true, now: T3 });
  comments = await getComments('p1');
  assert.deepEqual(comments.map((c) => `${c.id}:${c.order}`), ['c0:0', 'c1:1', 'r1:2', 'c2:3']);
});

test('comment order: before any full scan the latest save numbers the comments', async () => {
  await savePostBundle(makePost('p1'), [makeComment('p1', 'c1', { order: 0 }), makeComment('p1', 'c2', { order: 1 })], {
    fullScan: false,
    now: T1,
  });
  // An incomplete "post" scan that loaded more comments (c0 above c1) still renumbers.
  const partial = ['c0', 'c1', 'c2'].map((id, order) => makeComment('p1', id, { order }));
  await savePostBundle(makePost('p1'), partial, { fullScan: false, now: T2 });
  assert.deepEqual((await getComments('p1')).map((c) => `${c.id}:${c.order}`), ['c0:0', 'c1:1', 'c2:2']);
});

test('comment order: comments new to a fully scanned post are slotted after their DOM predecessor', async () => {
  // Full scan in pre-order: A, B (reply to A), C, D, E (reply to D), F.
  const reply = (id, parent, order) => makeComment('p1', id, { order, depth: 1, isReply: true, threadId: parent, parentId: parent });
  const full = [
    makeComment('p1', 'A', { order: 0 }),
    reply('B', 'A', 1),
    makeComment('p1', 'C', { order: 2 }),
    makeComment('p1', 'D', { order: 3 }),
    reply('E', 'D', 4),
    makeComment('p1', 'F', { order: 5 }),
  ];
  await savePostBundle(makePost('p1'), full, { fullScan: true, now: T1 });

  // A feed quick save shows D and a new reply G to D: G must sort under D, not at its index 1.
  await savePostBundle(makePost('p1', { lastMode: 'quick' }), [makeComment('p1', 'D', { order: 0 }), reply('G', 'D', 1)], {
    fullScan: false,
    now: T2,
  });
  let comments = await getComments('p1');
  assert.deepEqual(comments.map((c) => c.id), ['A', 'B', 'C', 'D', 'G', 'E', 'F']);
  const g = comments.find((c) => c.id === 'G');
  assert.ok(g.order > 3 && g.order < 4, `G order ${g.order}`);

  // A new top comment before the first visible one goes right before it; one after the last stored
  // one goes after it; a second new comment between D and G stays between them.
  await savePostBundle(
    makePost('p1', { lastMode: 'quick' }),
    [makeComment('p1', 'N', { order: 0 }), makeComment('p1', 'A', { order: 1 }), makeComment('p1', 'D', { order: 2 }), reply('H', 'D', 3), reply('G', 'D', 4), makeComment('p1', 'F', { order: 5 }), makeComment('p1', 'Z', { order: 6 })],
    { fullScan: false, now: T3 },
  );
  comments = await getComments('p1');
  assert.deepEqual(comments.map((c) => c.id), ['N', 'A', 'B', 'C', 'D', 'H', 'G', 'E', 'F', 'Z']);
  assert.equal(comments.find((c) => c.id === 'A').order, 0, 'stored orders are kept');
});

test('comment order: stored comments a renumbering save did not see keep their place', async () => {
  // Full scan, then a full scan where B is gone: B (missing) stays between A and C instead of
  // keeping its stale index 1, which now belongs to C.
  const three = ['A', 'B', 'C'].map((id, order) => makeComment('p1', id, { order }));
  await savePostBundle(makePost('p1'), three, { fullScan: true, now: T1 });
  await savePostBundle(makePost('p1'), [makeComment('p1', 'A', { order: 0 }), makeComment('p1', 'C', { order: 1 })], {
    fullScan: true,
    now: T2,
  });
  let comments = await getComments('p1');
  assert.deepEqual(comments.map((c) => `${c.id}:${c.order}:${c.missingAt ? 'missing' : 'ok'}`), ['A:0:ok', 'B:0.5:missing', 'C:1:ok']);

  // Before any full scan: a partial save renumbers, and a comment it did not show (a collapsed
  // reply) keeps its place after its old predecessor.
  await savePostBundle(makePost('p2'), [makeComment('p2', 'A', { order: 0 }), makeComment('p2', 'R', { order: 1, isReply: true, depth: 1, threadId: 'A', parentId: 'A' }), makeComment('p2', 'C', { order: 2 })], {
    fullScan: false,
    now: T1,
  });
  await savePostBundle(makePost('p2'), [makeComment('p2', 'X', { order: 0 }), makeComment('p2', 'A', { order: 1 }), makeComment('p2', 'C', { order: 2 })], {
    fullScan: false,
    now: T2,
  });
  comments = await getComments('p2');
  assert.deepEqual(comments.map((c) => c.id), ['X', 'A', 'R', 'C']);
  assert.ok(comments.every((c) => c.missingAt === null), 'a partial save marks nothing missing');
});

test('maxMissingRatio: a full scan that would mark too many comments missing is saved as partial', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => makeComment('p1', `c${i}`, { order: i }));
  await savePostBundle(makePost('p1'), ten, { fullScan: true, now: T1 });

  // 4 of 10 would go missing (> 25 %): downgraded — nothing marked, lastFullScanAt unchanged.
  const res = await savePostBundle(makePost('p1'), ten.slice(0, 6), { fullScan: true, now: T2, maxMissingRatio: 0.25 });
  assert.deepEqual(res, {
    inserted: 0,
    updated: 0,
    unchanged: 6,
    markedMissing: 0,
    total: 10,
    fullScanDowngraded: true,
    wouldMarkMissing: 4,
  });
  assert.ok((await getComments('p1')).every((c) => c.missingAt === null));
  assert.equal((await getPost('p1')).lastFullScanAt, T1);
  assert.deepEqual((await getComments('p1')).map((c) => c.order), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'partial: orders kept');

  // 1 of 10: a normal full scan.
  const ok = await savePostBundle(makePost('p1'), ten.slice(0, 9), { fullScan: true, now: T3, maxMissingRatio: 0.25 });
  assert.equal(ok.fullScanDowngraded, false);
  assert.equal(ok.markedMissing, 1);
  assert.equal((await getPost('p1')).lastFullScanAt, T3);

  // Fewer than 3 would go missing: always trusted, whatever the share.
  await savePostBundle(makePost('p2'), threeComments('p2'), { fullScan: true, now: T1 });
  const small = await savePostBundle(makePost('p2'), threeComments('p2').slice(0, 1), { fullScan: true, now: T2, maxMissingRatio: 0.25 });
  assert.equal(small.fullScanDowngraded, false);
  assert.equal(small.markedMissing, 2);
});

test('missing marking only touches comments of the saved post', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1'), { fullScan: true, now: T1 });
  await savePostBundle(makePost('p2'), threeComments('p2'), { fullScan: true, now: T1 });
  const res = await savePostBundle(makePost('p1'), [], { fullScan: true, now: T2 });
  assert.equal(res.markedMissing, 3);
  assert.ok((await getComments('p2')).every((c) => c.missingAt === null));
});

test('firstSavedAt preserved; post fields merge (null/empty never overwrite, lastMode always)', async () => {
  await savePostBundle(makePost('p1', { lastMode: 'post' }), threeComments('p1', T1), {
    fullScan: true,
    now: T1,
  });
  const res = await savePostBundle(
    makePost('p1', {
      firstSavedAt: T2,
      lastSavedAt: T2,
      lastMode: 'quick',
      authorName: null,
      authorUrl: '',
      postedAt: null,
      commentCountExpected: 5,
      text: 'Post body text, now edited',
    }),
    restamp(threeComments('p1'), T2),
    { fullScan: false, now: T2 },
  );
  assert.equal(res.unchanged, 3);

  const post = await getPost('p1');
  assert.equal(post.firstSavedAt, T1);
  assert.equal(post.lastSavedAt, T2);
  assert.equal(post.lastMode, 'quick');
  assert.equal(post.lastFullScanAt, T1, 'quick save keeps previous full-scan time');
  assert.equal(post.authorName, 'Post Author');
  assert.equal(post.authorUrl, 'https://www.facebook.com/profile.php?id=100');
  assert.equal(post.postedAt, '2026-09-30T08:00:00.000Z');
  assert.equal(post.commentCountExpected, 5);
  assert.equal(post.text, 'Post body text, now edited');

  for (const c of await getComments('p1')) assert.equal(c.firstSavedAt, T1);
});

test('post text: truncated feed preview does not replace full stored text', async () => {
  const full = 'A long post body that the feed shows truncated with a See more button.';
  await savePostBundle(makePost('p1', { text: full }), [], { now: T1 });
  await savePostBundle(makePost('p1', { text: 'A long post body that the feed…' }), [], { now: T2 });
  assert.equal((await getPost('p1')).text, full);
  await savePostBundle(makePost('p1', { text: '' }), [], { now: T3 });
  assert.equal((await getPost('p1')).text, full);
});

test('comment fields: incoming values win, null/empty keep stored', async () => {
  await savePostBundle(
    makePost('p1'),
    [
      makeComment('p1', 'c1', {
        authorId: '42',
        reactionCount: 5,
        attachments: [{ type: 'image', src: 'https://scontent.example/x.jpg', alt: '' }],
      }),
    ],
    { now: T1 },
  );
  const res = await savePostBundle(
    makePost('p1'),
    [makeComment('p1', 'c1', { authorId: null, reactionCount: 7, attachments: [], lastSavedAt: T2 })],
    { now: T2 },
  );
  assert.equal(res.updated, 1);
  const [c] = await getComments('p1');
  assert.equal(c.authorId, '42');
  assert.equal(c.reactionCount, 7);
  assert.equal(c.attachments.length, 1);
});

test('duplicate ids within one bundle are merged, counted once', async () => {
  const a = makeComment('p1', 'c1', { text: 'first' });
  const b = makeComment('p1', 'c1', { text: 'first' });
  const res = await savePostBundle(makePost('p1'), [a, b], { now: T1 });
  assert.deepEqual(res, { inserted: 1, updated: 0, unchanged: 0, markedMissing: 0, total: 1 });
});

test('savePostBundle is atomic: a failing write leaves nothing behind', async () => {
  const bad = makeComment('p1', 'c2', { attachments: [{ type: 'image', src: () => 'not cloneable' }] });
  await assert.rejects(savePostBundle(makePost('p1'), [makeComment('p1', 'c1'), bad], { now: T1 }));
  assert.equal(await getPost('p1'), undefined);
  assert.deepEqual(await getAllComments(), []);
  // The connection is still usable afterwards.
  await savePostBundle(makePost('p1'), [makeComment('p1', 'c1')], { now: T1 });
  assert.equal((await getAllComments()).length, 1);
});

test('savePostBundle validates ids', async () => {
  await assert.rejects(savePostBundle({}, [], {}), TypeError);
  await assert.rejects(savePostBundle(makePost('p1'), [{ text: 'no id' }], {}), TypeError);
});

test('concurrent saves of the same post are serialized', async () => {
  const [a, b] = await Promise.all([
    savePostBundle(makePost('p1'), threeComments('p1', T1), { now: T1 }),
    savePostBundle(makePost('p1'), threeComments('p1', T2), { now: T2 }),
  ]);
  assert.equal(a.inserted, 3);
  assert.deepEqual(b, { inserted: 0, updated: 0, unchanged: 3, markedMissing: 0, total: 3 });
});

test('now defaults to the current time', async () => {
  const before = Date.now();
  const post = makePost('p1');
  delete post.lastSavedAt;
  delete post.firstSavedAt;
  await savePostBundle(post, [], { fullScan: true });
  const stored = await getPost('p1');
  assert.ok(Date.parse(stored.lastSavedAt) >= before);
  assert.ok(Date.parse(stored.lastFullScanAt) >= before);
  assert.equal(stored.firstSavedAt, stored.lastSavedAt);
});

test('listPosts sorted by lastSavedAt desc', async () => {
  await savePostBundle(makePost('a', { lastSavedAt: T2 }), [], { now: T2 });
  await savePostBundle(makePost('b', { lastSavedAt: T1 }), [], { now: T1 });
  await savePostBundle(makePost('c', { lastSavedAt: T3 }), [], { now: T3 });
  assert.deepEqual(
    (await listPosts()).map((p) => p.id),
    ['c', 'a', 'b'],
  );
  // Re-saving moves a post to the top.
  await savePostBundle(makePost('b', { lastSavedAt: T4 }), [], { now: T4 });
  assert.deepEqual(
    (await listPosts()).map((p) => p.id),
    ['b', 'c', 'a'],
  );
});

test('getComments sorted by order then createdAt, only that post', async () => {
  await savePostBundle(
    makePost('p1'),
    [
      makeComment('p1', 'x', { order: 2 }),
      makeComment('p1', 'y', { order: 0, createdAt: '2026-10-01T12:00:00.000Z' }),
      makeComment('p1', 'z', { order: 0, createdAt: '2026-10-01T11:00:00.000Z' }),
      makeComment('p1', 'w', { order: 1 }),
    ],
    { now: T1 },
  );
  await savePostBundle(makePost('p2'), [makeComment('p2', 'other', { order: 0 })], { now: T1 });
  assert.deepEqual(
    (await getComments('p1')).map((c) => c.id),
    ['z', 'y', 'w', 'x'],
  );
  assert.deepEqual(await getComments('missing'), []);
  assert.equal((await getAllComments()).length, 5);
});

test('searchComments: case-insensitive on text and authorName, incl. Myanmar text', async () => {
  await savePostBundle(
    makePost('p1'),
    [
      makeComment('p1', 'a', { authorName: 'Thura Min Oo', text: 'There is hardly a DEGREE requirement' }),
      makeComment('p1', 'b', { authorName: 'Chai_lover🍵', text: 'မင်္ဂလာပါ ခင်ဗျာ Software Engineer တွေ' }),
      makeComment('p1', 'c', { authorName: 'ကိုကို', text: 'Thanks for sharing' }),
    ],
    { now: T1 },
  );
  await savePostBundle(makePost('p2'), [makeComment('p2', 'd', { text: 'degree or bootcamp?' })], { now: T1 });

  const ids = async (q, opts) => (await searchComments(q, opts)).map((c) => c.id).sort();
  assert.deepEqual(await ids('degree'), ['a', 'd']);
  assert.deepEqual(await ids('THURA'), ['a']);
  assert.deepEqual(await ids('min oo'), ['a']);
  assert.deepEqual(await ids('မင်္ဂလာ'), ['b']);
  assert.deepEqual(await ids('ကိုကို'), ['c']);
  assert.deepEqual(await ids('software engineer'), ['b']);
  assert.deepEqual(await ids('🍵'), ['b']);
  assert.deepEqual(await ids('nothing matches this'), []);
  assert.deepEqual(await ids('   '), []);
  assert.equal((await searchComments('e', { limit: 2 })).length, 2);
  assert.equal((await searchComments('degree')).length, 2, 'options are optional');
});

test('getStats', async () => {
  assert.deepEqual(await getStats(), { posts: 0, comments: 0, lastSavedAt: null });
  await savePostBundle(makePost('p1', { lastSavedAt: T2 }), threeComments('p1'), { now: T2 });
  await savePostBundle(makePost('p2', { lastSavedAt: T1 }), threeComments('p2').slice(0, 1), { now: T1 });
  assert.deepEqual(await getStats(), { posts: 2, comments: 4, lastSavedAt: T2 });
});

test('deletePost removes the post and only its comments', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1'), { now: T1 });
  await savePostBundle(makePost('p2'), threeComments('p2'), { now: T1 });
  await deletePost('p1');
  assert.equal(await getPost('p1'), undefined);
  assert.deepEqual(await getComments('p1'), []);
  assert.ok(await getPost('p2'));
  assert.equal((await getComments('p2')).length, 3);
  assert.deepEqual(await getStats(), { posts: 1, comments: 3, lastSavedAt: T1 });
  await deletePost('does-not-exist'); // no throw
});

test('clearAll empties both stores', async () => {
  await savePostBundle(makePost('p1'), threeComments('p1'), { now: T1 });
  await savePostBundle(makePost('p2'), threeComments('p2'), { now: T1 });
  await clearAll();
  assert.deepEqual(await listPosts(), []);
  assert.deepEqual(await getAllComments(), []);
  assert.deepEqual(await getStats(), { posts: 0, comments: 0, lastSavedAt: null });
});

test('postsScannedSince returns ids with lastFullScanAt >= ms', async () => {
  await savePostBundle(makePost('old'), [], { fullScan: true, now: T1 });
  await savePostBundle(makePost('new'), [], { fullScan: true, now: T3 });
  await savePostBundle(makePost('quick'), [], { fullScan: false, now: T4 });
  await savePostBundle(makePost('edge'), [], { fullScan: true, now: T2 });

  const since = await postsScannedSince(Date.parse(T2));
  assert.ok(since instanceof Set);
  assert.deepEqual([...since].sort(), ['edge', 'new']);
  assert.deepEqual([...(await postsScannedSince(0))].sort(), ['edge', 'new', 'old']);
  assert.equal((await postsScannedSince(Date.parse(T4))).size, 0);
});

test('deleteDatabase from elsewhere is not blocked; next call reopens', async () => {
  await savePostBundle(makePost('p1'), [], { now: T1 });
  await new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  assert.deepEqual(await listPosts(), []);
});
