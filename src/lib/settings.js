// User settings persisted in chrome.storage.local. See SPEC.md §3.

import { DEFAULT_GROUP_URL, DEFAULT_SETTINGS, SETTINGS_KEY } from './constants.js';
import { isFacebookHost } from './fb-url.js';

/** @typedef {import('./constants.js').Settings} Settings */

/** Inclusive [min, max] bounds for numeric settings. */
export const SETTING_LIMITS = Object.freeze({
  maxPosts: [1, 500],
  skipSavedWithinHours: [0, 8760],
  actionDelayMs: [100, 10000],
  maxExpandRounds: [1, 200],
  postTimeoutSec: [30, 1800],
});

/** Allowed values of `feedSort` ('DEFAULT' = no ?sorting_setting= parameter). */
export const FEED_SORTS = Object.freeze(['CHRONOLOGICAL', 'RECENT_ACTIVITY', 'TOP_POSTS', 'DEFAULT']);

const BOOLEAN_KEYS = ['sortAllComments', 'expandReplies', 'expandSeeMore', 'returnToGroupAfterCrawl'];

/** Setting key → key in the object returned by compilePatterns(). */
const PATTERN_KEYS = {
  expanderPattern: 'expander',
  seeMorePattern: 'seeMore',
  sortButtonPattern: 'sortButton',
  sortAllItemPattern: 'sortAllItem',
};

function clampNumber(value, [min, max], fallback) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Returns a complete, valid settings object: unknown keys dropped, numbers clamped,
 * booleans/enums/strings coerced, anything unusable replaced by its default.
 * @param {Partial<Settings>|undefined|null} input
 * @returns {Settings}
 */
export function sanitizeSettings(input) {
  const src = input && typeof input === 'object' ? input : {};
  /** @type {any} */
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in src && src[key] !== undefined) out[key] = src[key];
  }

  for (const [key, range] of Object.entries(SETTING_LIMITS)) {
    out[key] = clampNumber(out[key], range, DEFAULT_SETTINGS[key]);
  }
  for (const key of BOOLEAN_KEYS) out[key] = toBoolean(out[key], DEFAULT_SETTINGS[key]);

  out.groupUrl = typeof out.groupUrl === 'string' && out.groupUrl.trim() ? out.groupUrl.trim() : DEFAULT_SETTINGS.groupUrl;
  const sort = typeof out.feedSort === 'string' ? out.feedSort.trim().toUpperCase() : '';
  out.feedSort = FEED_SORTS.includes(sort) ? sort : DEFAULT_SETTINGS.feedSort;

  // Empty patterns would match every button — treat them as "use default".
  for (const key of Object.keys(PATTERN_KEYS)) {
    if (typeof out[key] !== 'string' || !out[key].trim()) out[key] = DEFAULT_SETTINGS[key];
  }
  return out;
}

function storageArea() {
  const area = globalThis.chrome?.storage?.local;
  if (!area) throw new Error('chrome.storage.local is not available');
  return area;
}

/**
 * Reads settings from chrome.storage.local, filling in defaults.
 * @returns {Promise<Settings>}
 */
export async function getSettings() {
  const got = await storageArea().get(SETTINGS_KEY);
  const stored = got ? got[SETTINGS_KEY] : undefined;
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) });
}

/**
 * Merges `patch` into the stored settings, validates/clamps, persists and returns the result.
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const merged = sanitizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  await storageArea().set({ [SETTINGS_KEY]: merged });
  return merged;
}

/** Accepts a full URL, a scheme-less URL ("facebook.com/groups/x") or a bare group slug. */
function parseGroupUrl(input) {
  let s = typeof input === 'string' ? input.trim() : '';
  if (!s) s = DEFAULT_GROUP_URL;
  if (/^[\w.-]+$/.test(s) && !/facebook\.com$/i.test(s)) s = `https://www.facebook.com/groups/${s}`;
  else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    return new URL(s);
  } catch {
    return new URL(DEFAULT_GROUP_URL);
  }
}

/**
 * The group feed URL to open for a crawl: groupUrl with ?sorting_setting=<feedSort>
 * (replacing any existing value), or without that parameter when feedSort is 'DEFAULT'.
 * @param {Partial<Settings>} settings
 * @returns {string}
 */
export function buildGroupFeedUrl(settings) {
  const s = settings || {};
  const url = parseGroupUrl(s.groupUrl);
  url.hash = '';
  const sort = typeof s.feedSort === 'string' ? s.feedSort.trim().toUpperCase() : DEFAULT_SETTINGS.feedSort;
  if (!sort || sort === 'DEFAULT') url.searchParams.delete('sorting_setting');
  else url.searchParams.set('sorting_setting', sort);
  return url.toString();
}

/**
 * True when `url` already shows the feed a crawl would open: the group's main feed
 * (/groups/<slug>, optionally /discussion) — not another group page such as Members, About or a
 * member's posts — with the same ?sorting_setting= as buildGroupFeedUrl(settings) (none for
 * 'DEFAULT'). The host is not compared (www. and web.facebook.com are the same site).
 * @param {string|null|undefined} url
 * @param {Partial<Settings>} settings
 * @returns {boolean}
 */
export function isGroupFeedUrl(url, settings) {
  let u;
  let want;
  try {
    u = new URL(String(url ?? ''));
    want = new URL(buildGroupFeedUrl(settings));
  } catch {
    return false;
  }
  if (!isFacebookHost(u.hostname)) return false;
  const slugOf = (pathname) => {
    const m = /^\/groups\/([^/]+)(?:\/discussion)?\/?$/i.exec(pathname);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]).toLowerCase();
    } catch {
      return m[1].toLowerCase();
    }
  };
  const slug = slugOf(u.pathname);
  if (!slug || slug !== slugOf(want.pathname)) return false;
  const sortOf = (x) => (x.searchParams.get('sorting_setting') || '').toUpperCase();
  return sortOf(u) === sortOf(want);
}

/**
 * Returns true when `source` compiles as a regular expression (flag 'i').
 * @param {string} source
 */
export function isValidPattern(source) {
  if (typeof source !== 'string' || !source.trim()) return false;
  try {
    new RegExp(source, 'i');
    return true;
  } catch {
    return false;
  }
}

/**
 * Compiles the *Pattern settings (flag 'i'); an invalid or empty pattern falls back to the default.
 * Test them against element text with whitespace collapsed: text.replace(/\s+/g, ' ').trim().
 * @param {Partial<Settings>} settings
 * @returns {{expander: RegExp, seeMore: RegExp, sortButton: RegExp, sortAllItem: RegExp}}
 */
export function compilePatterns(settings) {
  const s = settings || {};
  /** @type {any} */
  const out = {};
  for (const [settingKey, outKey] of Object.entries(PATTERN_KEYS)) {
    const source = isValidPattern(s[settingKey]) ? s[settingKey] : DEFAULT_SETTINGS[settingKey];
    out[outKey] = new RegExp(source, 'i');
  }
  return out;
}
