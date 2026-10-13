import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseFbDate } from '../../src/lib/fb-date.js';

// Reference "now": Wednesday 14 October 2026, 12:00 local time.
const REF = new Date(2026, 9, 14, 12, 0).getTime();
const local = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).toISOString();
const ago = (ms) => new Date(REF - ms).toISOString();
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function check(text, iso, approx) {
  assert.deepEqual(parseFbDate(text, REF), { iso, approx }, text);
}

describe('absolute dates with time (approx:false)', () => {
  const cases = [
    ['Sunday 4 October 2026 at 18:23', local(2026, 9, 4, 18, 23)],
    ['Sunday, October 4, 2026 at 6:23 PM', local(2026, 9, 4, 18, 23)],
    ['4 October 2026 at 18:23', local(2026, 9, 4, 18, 23)],
    ['October 4, 2026 at 6:23 PM', local(2026, 9, 4, 18, 23)],
    ['Sunday 11 October 2026 at 08:54', local(2026, 9, 11, 8, 54)],
    ['sunday 4 october 2026 at 18:23', local(2026, 9, 4, 18, 23)],
    ['SUNDAY, 4 OCTOBER 2026 AT 18:23', local(2026, 9, 4, 18, 23)],
    ['Sun, Oct 4, 2026 at 6:23 pm', local(2026, 9, 4, 18, 23)],
    ['4 Sept 2026 at 07:05', local(2026, 8, 4, 7, 5)],
    ['Friday 1 January 2021 at 00:00', local(2021, 0, 1, 0, 0)],
    ['Thursday, December 31, 2020 at 11:59 PM', local(2020, 11, 31, 23, 59)],
    ['October 4, 2026, 6:23 PM', local(2026, 9, 4, 18, 23)],
    ['4 October 2026 at 6:23 p.m.', local(2026, 9, 4, 18, 23)],
    ['4 October 2026 at 6 PM', local(2026, 9, 4, 18, 0)],
    ['Sunday 4 October 2026 at 18:23', local(2026, 9, 4, 18, 23)], // narrow no-break space
  ];
  for (const [text, iso] of cases) test(text, () => check(text, iso, false));

  test('12 AM / 12 PM', () => {
    check('Today at 12:30 AM', local(2026, 9, 14, 0, 30), false);
    check('Today at 12:15 PM', local(2026, 9, 14, 12, 15), false);
  });

  test('extra whitespace is collapsed', () => {
    check('  Sunday   4 October\n2026  at  18:23 ', local(2026, 9, 4, 18, 23), false);
  });
});

describe('dates without a year', () => {
  test('"4 October at 18:19" → year of refMs', () => check('4 October at 18:19', local(2026, 9, 4, 18, 19), false));
  test('"October 4 at 6:19 PM" → year of refMs', () => check('October 4 at 6:19 PM', local(2026, 9, 4, 18, 19), false));
  test('a date within 36 h after refMs keeps the year', () => check('15 October at 10:00', local(2026, 9, 15, 10, 0), false));
  test('a date more than 36 h after refMs → previous year', () => {
    check('16 October at 10:00', local(2025, 9, 16, 10, 0), false);
    check('20 December at 10:00', local(2025, 11, 20, 10, 0), false);
    check('December 20 at 9:00 AM', local(2025, 11, 20, 9, 0), false);
  });
  test('weekday + no year', () => check('Sunday 4 October at 18:19', local(2026, 9, 4, 18, 19), false));
});

describe('today / yesterday / weekday', () => {
  test('"Yesterday at 10:00"', () => check('Yesterday at 10:00', local(2026, 9, 13, 10, 0), false));
  test('"Today at 9:05 AM"', () => check('Today at 9:05 AM', local(2026, 9, 14, 9, 5), false));
  test('"yesterday at 11:45 pm"', () => check('yesterday at 11:45 pm', local(2026, 9, 13, 23, 45), false));
  test('"Yesterday" (date only) → approx', () => check('Yesterday', local(2026, 9, 13), true));
  test('yesterday across a month boundary', () => {
    const ref = new Date(2026, 10, 1, 8, 0).getTime();
    assert.deepEqual(parseFbDate('Yesterday at 22:10', ref), { iso: local(2026, 9, 31, 22, 10), approx: false });
  });
  test('"Monday at 10:00" → most recent past Monday', () => check('Monday at 10:00', local(2026, 9, 12, 10, 0), false));
  test('same weekday as refMs → a week back', () => check('Wednesday at 10:00', local(2026, 9, 7, 10, 0), false));
});

describe('date only (approx:true, local midnight)', () => {
  test('"4 October 2026"', () => check('4 October 2026', local(2026, 9, 4), true));
  test('"October 4, 2026"', () => check('October 4, 2026', local(2026, 9, 4), true));
  test('"Sunday, October 4, 2026"', () => check('Sunday, October 4, 2026', local(2026, 9, 4), true));
  test('"4 October" (no year)', () => check('4 October', local(2026, 9, 4), true));
  test('"Oct 4"', () => check('Oct 4', local(2026, 9, 4), true));
  test('"2026-10-04"', () => check('2026-10-04', local(2026, 9, 4), true));
});

describe('relative times (approx:true)', () => {
  const cases = [
    ['Just now', 0],
    ['just now', 0],
    ['a few seconds ago', 0],
    ['5m', 5 * MIN],
    ['5 m', 5 * MIN],
    ['5 min', 5 * MIN],
    ['5 mins', 5 * MIN],
    ['5 minutes ago', 5 * MIN],
    ['30s', 30e3],
    ['5h', 5 * HOUR],
    ['5 hrs', 5 * HOUR],
    ['1d', DAY],
    ['1w', 7 * DAY],
    ['2y', 2 * 365 * DAY],
    ['5 hours ago', 5 * HOUR],
    ['a day ago', DAY],
    ['an hour ago', HOUR],
    ['2 days ago', 2 * DAY],
    ['a week ago', 7 * DAY],
    ['3 weeks ago', 21 * DAY],
    ['a month ago', 30 * DAY],
    ['2 months ago', 60 * DAY],
    ['2 years ago', 2 * 365 * DAY],
    ['A year ago', 365 * DAY],
  ];
  for (const [text, ms] of cases) test(text, () => check(text, ago(ms), true));
});

describe('aria-labels with a trailing relative time', () => {
  test('"Comment by Thura Min Oo 2 days ago"', () => check('Comment by Thura Min Oo 2 days ago', ago(2 * DAY), true));
  test("reply label with short time", () => check("Reply by Snow2Rain2 to Thura Min Oo's comment 5h", ago(5 * HOUR), true));
  test('"Comment by BrightOtter3141 an hour ago"', () => check('Comment by BrightOtter3141 an hour ago', ago(HOUR), true));
  test('"Comment by Chai_lover🍵 Just now"', () => check('Comment by Chai_lover🍵 Just now', ago(0), true));
});

describe('unparseable', () => {
  for (const text of ['', null, undefined, 'Edited', 'Comment by Thura Min Oo', 'hello world', '31 June 2026', '30 February 2026 at 10:00', '4 October 2026 at 25:00', '4 October 2026 at 13:00 PM', 'Smarch 4, 2026']) {
    test(JSON.stringify(text), () => assert.deepEqual(parseFbDate(text, REF), { iso: null, approx: true }));
  }
});

describe('misc', () => {
  test('full ISO timestamps pass through exactly', () => {
    assert.deepEqual(parseFbDate('2026-10-04T11:53:00.000Z', REF), { iso: '2026-10-04T11:53:00.000Z', approx: false });
  });

  test('refMs defaults to now', () => {
    const before = Date.now();
    const { iso, approx } = parseFbDate('Just now');
    assert.equal(approx, true);
    const t = Date.parse(iso);
    assert.ok(t >= before && t <= Date.now());
  });

  test('refMs may be a Date', () => {
    assert.deepEqual(parseFbDate('1h', new Date(REF)), { iso: ago(HOUR), approx: true });
  });
});
