// Parsing of Facebook's (English UI) absolute and relative date strings. See SPEC.md §5.

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7,
  september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?';
const ORDINAL = '(?:st|nd|rd|th)?';

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const WEEKDAY_RE = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\.?(?=[\s,]|$),?\s*/i;

// Trailing time: "at 18:23", ", 6:23 PM", " 9:05 a.m.", "at 6 PM" (minutes optional only with AM/PM).
const TIME_RE = /(?:^at\s+|\s+at\s+|\s*,\s*|\s+|^)(\d{1,2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?)?$/i;
const DMY_RE = new RegExp(`^(\\d{1,2})${ORDINAL}\\s+${MONTH},?(?:\\s+(\\d{4}))?$`, 'i');
const MDY_RE = new RegExp(`^${MONTH}\\s+(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?$`, 'i');
const YMD_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

// Relative units. FB short forms: "5m" = minutes, "1w" = week, "2y" = years.
const UNIT = '(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)';
const REL_RE = new RegExp(
  `(?:^|\\s)(?:(just now|now|a few seconds(?: ago)?|moments ago)|(\\d+|an?|one)\\s?${UNIT}(?:\\s+ago)?)$`,
  'i',
);

const HOUR = 3600e3;
const DAY = 24 * HOUR;

function unitMs(unit) {
  const u = unit.toLowerCase();
  if (/^(s|secs?|seconds?)$/.test(u)) return 1e3;
  if (/^(m|mins?|minutes?)$/.test(u)) return 60e3;
  if (/^(h|hrs?|hours?)$/.test(u)) return HOUR;
  if (/^(d|days?)$/.test(u)) return DAY;
  if (/^(w|wks?|weeks?)$/.test(u)) return 7 * DAY;
  if (/^(mo|mos|months?)$/.test(u)) return 30 * DAY;
  return 365 * DAY; // y, yr(s), year(s)
}

/**
 * Splits a trailing time off `s`. Returns null when a time is present but invalid.
 * @returns {{rest: string, time: {h: number, min: number}|null}|null}
 */
function splitTime(s) {
  const m = TIME_RE.exec(s);
  if (!m) return { rest: s, time: null };
  const [, hStr, minStr, ampm] = m;
  if (minStr === undefined && !ampm) return { rest: s, time: null }; // e.g. "October 4" — a day, not a time
  let h = Number(hStr);
  const min = minStr === undefined ? 0 : Number(minStr);
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ampm.toLowerCase() === 'p' ? 12 : 0);
  } else if (h > 23) {
    return null;
  }
  const rest = s.slice(0, m.index).replace(/[\s,]+$/, '');
  return { rest, time: { h, min } };
}

/** Builds a local Date and checks the day did not roll over (e.g. 31 June). */
function localDate(y, mo, d, h, min) {
  const date = new Date(y, mo, d, h, min);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? date : null;
}

/** Absolute formats → {iso, approx} or null when `s` is not one of them. */
function parseAbsolute(s, refMs) {
  let text = s;
  let weekday = null;
  const wm = WEEKDAY_RE.exec(text);
  if (wm) {
    weekday = wm[1].toLowerCase();
    text = text.slice(wm[0].length);
  }
  const split = splitTime(text);
  if (!split) return null;
  const { rest, time } = split;
  const h = time ? time.h : 0;
  const min = time ? time.min : 0;
  const ref = new Date(refMs);
  let date = null;
  let m;

  if (/^(today|yesterday)$/i.test(rest)) {
    const back = /^yesterday$/i.test(rest) ? 1 : 0;
    date = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - back, h, min);
  } else if ((m = DMY_RE.exec(rest)) || (m = MDY_RE.exec(rest))) {
    const dmy = /^\d/.test(rest);
    const day = Number(dmy ? m[1] : m[2]);
    const month = MONTHS[(dmy ? m[2] : m[1]).toLowerCase()];
    if (m[3]) {
      date = localDate(Number(m[3]), month, day, h, min);
    } else {
      // No year: assume the year of refMs, unless that lands clearly in the future.
      date = localDate(ref.getFullYear(), month, day, h, min);
      if (date && date.getTime() > refMs + 36 * HOUR) date = localDate(ref.getFullYear() - 1, month, day, h, min);
    }
  } else if ((m = YMD_RE.exec(rest))) {
    date = localDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, min);
  } else if (rest === '' && weekday) {
    // "Tuesday at 10:00" → the most recent past Tuesday (1–7 days back; FB says "Today" for today).
    const back = (ref.getDay() - WEEKDAYS[expandWeekday(weekday)] + 7) % 7 || 7;
    date = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - back, h, min);
  } else {
    return null;
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), approx: !time };
}

function expandWeekday(w) {
  return Object.keys(WEEKDAYS).find((full) => full.startsWith(w.slice(0, 3))) || 'sunday';
}

/** Relative formats ("5h", "2 days ago", "Just now"; also trailing part of an aria-label). */
function parseRelative(s, refMs) {
  const m = REL_RE.exec(s);
  if (!m) return null;
  let ms = 0;
  if (!m[1]) {
    const amount = /^\d+$/.test(m[2]) ? Number(m[2]) : 1; // "a" / "an" / "one"
    ms = amount * unitMs(m[3]);
  }
  return { iso: new Date(refMs - ms).toISOString(), approx: true };
}

function toRefMs(refMs) {
  if (refMs instanceof Date) return refMs.getTime();
  if (typeof refMs === 'number' && Number.isFinite(refMs)) return refMs;
  if (typeof refMs === 'string' && Number.isFinite(Date.parse(refMs))) return Date.parse(refMs);
  return Date.now();
}

/**
 * Parses a Facebook date string. Absolute dates are local time (approx:false when a time of day is
 * present); relative ones are refMs minus the amount (approx:true). Unparseable → {iso:null, approx:true}.
 * @param {string|null|undefined} text
 * @param {number} [refMs] reference "now" (defaults to Date.now())
 * @returns {{iso: string|null, approx: boolean}}
 */
export function parseFbDate(text, refMs) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (!s) return { iso: null, approx: true };
  const ref = toRefMs(refMs);

  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && Number.isFinite(Date.parse(s))) {
    return { iso: new Date(Date.parse(s)).toISOString(), approx: false };
  }
  return parseAbsolute(s, ref) || parseRelative(s, ref) || { iso: null, approx: true };
}
