import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDiagnosticsReport, maskDigits, maskLogLine, urlShape } from '../../src/lib/diagnostics.js';
import { normalizeExtraction } from '../../src/lib/normalize.js';

test('maskDigits masks runs of 5+ digits only', () => {
  assert.equal(maskDigits('post 1500000000000001, 1001 and 12345'), 'post {n}, 1001 and {n}');
});

test('urlShape keeps structure, drops the group, ids, values and tracking keys', () => {
  assert.equal(
    urlShape('https://www.facebook.com/groups/1500000000000001?sorting_setting=CHRONOLOGICAL'),
    'fb:/groups/{g}?sorting_setting',
  );
  assert.equal(
    urlShape('https://www.facebook.com/groups/myanmarsoftwareengineers/posts/1600000000000001/?comment_id=9&__cft__[0]=AZ'),
    'fb:/groups/{g}/posts/{n}/?comment_id',
  );
  assert.equal(urlShape('https://www.facebook.com/john.doe.123'), 'fb:/{s}');
  assert.equal(urlShape('https://example.com/a?b=c'), 'ext:/{s}?b');
  assert.equal(urlShape('not a url'), '{url}');
});

test('maskLogLine removes author names and URLs from job log lines', () => {
  assert.equal(
    maskLogLine('Post 2/4: https://www.facebook.com/groups/testgroup/posts/1002/ (Kyaw Zin Thant)'),
    'Post 2/4: fb:/groups/{g}/posts/1002/ (author)',
  );
  assert.equal(
    maskLogLine('Skipped post #1 by Thura Min Oo: no post id found (3 comments not saved).'),
    'Skipped post #1 by (author): no post id found (3 comments not saved).',
  );
  assert.equal(
    maskLogLine('Opening the group feed: https://www.facebook.com/groups/1500000000000001?sorting_setting=CHRONOLOGICAL'),
    'Opening the group feed: fb:/groups/{g}?sorting_setting',
  );
  assert.equal(maskLogLine('Saved post 1600000000000001: 19 comments'), 'Saved post {n}: 19 comments');
});

test('maskLogLine: names with line breaks or ": " never survive', () => {
  // A name read from a link that also holds a badge line ("Top contributor", "Admin").
  assert.equal(
    maskLogLine('Post 1/1: https://www.facebook.com/groups/secret.slug/posts/1234567890123456/ (Kyaw Zin Thant\nTop contributor)'),
    'Post 1/1: fb:/groups/{g}/posts/{n}/ (author)',
  );
  assert.equal(
    maskLogLine('Skipped post #2 by Thida Aung\nAdmin: no post id found (0 comments not saved).'),
    'Skipped post #2 by (author): no post id found (0 comments not saved).',
  );
  assert.equal(
    maskLogLine('Skipped post #1 by Radio: FM Yangon Page: no post id found (1 comment not saved).'),
    'Skipped post #1 by (author): no post id found (1 comment not saved).',
  );
  // A name that itself contains the fixed suffix text is still removed whole.
  assert.equal(
    maskLogLine('Skipped post #3 by A: no post id found (2 comments not saved). B: no post id found (5 comments not saved).'),
    'Skipped post #3 by (author): no post id found (5 comments not saved).',
  );
});

test('maskLogLine: the real job-runner / normalize lines with multi-line names are masked', () => {
  const names = ['Thida Aung\nAdmin', 'Radio: FM Yangon Page', 'Kyaw Zin Thant\n\nTop contributor'];
  const raw = {
    pageUrl: 'https://www.facebook.com/groups/secret.slug/',
    rootKind: 'feed',
    extractedAt: Date.parse('2026-10-14T00:00:00Z'),
    posts: names.map((authorName) => ({ permalinkHref: null, authorName, authorHref: null, text: 'Secret body', items: [] })),
  };
  const { warnings } = normalizeExtraction(raw, { savedAt: '2026-10-14T00:00:00.000Z', fallbackGroupSlug: null, mode: 'quick' });
  const skipped = warnings.filter((w) => /^Skipped post #/.test(w));
  assert.equal(skipped.length, 3);
  for (const w of skipped) assert.doesNotMatch(w, /\n/, 'one line per warning');
  const masked = skipped.map(maskLogLine).join('\n');
  for (const part of ['Thida', 'Admin', 'Radio', 'FM Yangon', 'Kyaw', 'contributor']) {
    assert.ok(!masked.includes(part), `masked warnings still contain "${part}": ${masked}`);
  }
  assert.match(masked, /^Skipped post #1 by \(author\): no post id found \(0 comments not saved\)\.$/m);
});

test('maskDigits / maskLogLine mask pfbid post ids', () => {
  assert.equal(maskDigits('pfbid02xYzAbC1234Kq7LmNoPqRsTuVwXyZl'), '{pfbid}');
  assert.equal(
    maskLogLine('Saved post pfbid02xYzAbC1234Kq7LmNoPqRsTuVwXyZl: 0 comments (0 new, 0 updated, 0 missing)'),
    'Saved post {pfbid}: 0 comments (0 new, 0 updated, 0 missing)',
  );
  assert.equal(
    maskLogLine('The page showed post PFBID0AbC9, not pfbid0Zz1; saving it as a partial scan.'),
    'The page showed post {pfbid}, not {pfbid}; saving it as a partial scan.',
  );
  // The real normalize path: a post-mode save of a pfbid URL without comment permalinks.
  const raw = {
    rootKind: 'dialog',
    pageUrl: 'https://www.facebook.com/groups/secret.slug/posts/pfbid02xYzAbC1234Kq7LmNoPqRsTuVwXyZl/',
    extractedAt: Date.parse('2026-10-14T00:00:00Z'),
    posts: [{ permalinkHref: null, authorName: 'A', authorHref: null, text: 'x', items: [] }],
  };
  const { posts } = normalizeExtraction(raw, { savedAt: '2026-10-14T00:00:00.000Z', fallbackGroupSlug: null, mode: 'post' });
  assert.equal(posts[0].id, 'pfbid02xYzAbC1234Kq7LmNoPqRsTuVwXyZl');
  assert.doesNotMatch(maskLogLine(`Saved post ${posts[0].id}: 0 comments`), /pfbid0/i);
});

test('buildDiagnosticsReport: extension part with the last 40 masked log lines', () => {
  const log = Array.from({ length: 50 }, (_, i) => ({ t: '2026-10-14T00:00:00.000Z', level: 'info', msg: `line ${i} 123456789` }));
  const report = buildDiagnosticsReport({
    version: '1.0.0',
    userAgent: 'Mozilla/5.0 Chrome/141.0.7390.37 Build/1234567',
    language: 'en-US',
    page: { rootKind: 'feed' },
    job: { mode: 'crawl', status: 'done', phase: 'Done', postsTotal: 0, postsDone: 0, error: null, log, secret: 'x' },
    now: '2026-10-14T00:00:00.000Z',
  });
  assert.equal(report.extension, '1.0.0');
  assert.equal(report.userAgent, 'Mozilla/5.0 Chrome/141.0.7390.37 Build/{n}');
  assert.deepEqual(report.page, { rootKind: 'feed' });
  assert.equal(report.lastJob.mode, 'crawl');
  assert.equal(report.lastJob.counters.postsTotal, 0);
  assert.equal(report.lastJob.log.length, 40);
  assert.equal(report.lastJob.log[0].msg, 'line 10 {n}');
  assert.ok(!('secret' in report.lastJob));
  assert.doesNotMatch(JSON.stringify(report), /\d{5,}/);
  assert.equal(buildDiagnosticsReport({ version: '1', job: null, pageNote: 'Not Facebook' }).lastJob, null);
});
