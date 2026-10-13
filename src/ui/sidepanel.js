// Side panel controller. See SPEC.md §8.
// Talks to the service worker with MSG.START_JOB / STOP_JOB / GET_JOB, mirrors the JobState kept in
// chrome.storage.session, edits settings, and shows archive stats + exports.

import { MSG, JOB_STATE_KEY, SETTINGS_KEY, DEFAULT_SETTINGS } from '../lib/constants.js';
import { getSettings, saveSettings, buildGroupFeedUrl } from '../lib/settings.js';
import { classifyTabUrl } from '../lib/fb-url.js';
import { getStats, getPost } from '../lib/db.js';
import {
  el,
  formatDate,
  relTime,
  relTimeShort,
  formatDuration,
  formatNumber,
  plural,
  debounce,
  exportArchive,
  openLibrary,
  showToast,
} from './common.js';

/** @typedef {import('../lib/constants.js').Settings} Settings */
/** @typedef {{ kind: string, groupSlug: string|null, postId: string|null }} TabInfo */
/**
 * @typedef {{ id?: string, mode?: string, status: string, tabId?: number, startedAt?: string, finishedAt?: string|null,
 *   phase?: string, postsTotal?: number, postsDone?: number, postsFailed?: number, commentsSeen?: number,
 *   inserted?: number, updated?: number, markedMissing?: number, currentPostUrl?: string|null, error?: string|null,
 *   log?: { t: string, level: string, msg: string }[] }} JobState
 */

const FB_KINDS = new Set(['post', 'group', 'facebook']);
const ACTIVE_STATUSES = new Set(['running', 'stopping']);

/** Status chip for the active tab (labels per SPEC §8). */
const TAB_KIND_META = {
  post: { label: 'Post', tone: 'ok' },
  group: { label: 'Group feed', tone: 'info' },
  facebook: { label: 'Facebook (other page)', tone: 'neutral' },
  mobile: { label: 'Mobile site (unsupported)', tone: 'warn' },
  other: { label: 'Not Facebook', tone: 'neutral' },
};

const STATUS_META = {
  idle: { label: 'Idle', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  stopping: { label: 'Stopping…', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  error: { label: 'Error', tone: 'danger' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
};

const MODE_LABEL = { quick: 'Quick save', post: 'Save all comments', crawl: 'Group crawl' };

/** Settings edited in the "Group crawl" card; everything else belongs to the Settings section. */
const CRAWL_KEYS = ['groupUrl', 'feedSort', 'maxPosts', 'skipSavedWithinHours'];
const SECTION_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => !CRAWL_KEYS.includes(k));

/** Facebook buttons a text pattern must never match — the driver would click them. */
const FORBIDDEN_LABELS = ['Like', 'React', 'Reply', 'Share', 'Send', 'Comment', 'Hide', 'Hide replies', 'Delete', 'Report', 'Follow', 'Join group'];

const MOBILE_REASON = 'The mobile site (m.facebook.com) isn’t supported — open the page on www.facebook.com.';
const GROUP_URL_EXAMPLE = 'https://www.facebook.com/groups/myanmarsoftwareengineers';
const DISMISSED_KEY = 'fbcs.dismissedJobId';

/** Default tooltips for enabled buttons (disabled buttons show the reason instead). */
const TIPS = {
  'btn-save-post': 'Switch to “All comments”, expand every reply and “See more”, then save the whole thread',
  'btn-quick-save': 'Save only the comments already shown on the page — no clicking or scrolling',
  'btn-crawl': 'Collect posts from the group feed, then save every comment of each post',
  'btn-open-group': 'Open the group feed (in this tab if it is a Facebook tab)',
};

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const state = {
  /** @type {chrome.tabs.Tab|null} */
  tab: null,
  /** @type {TabInfo} */
  info: { kind: 'other', groupSlug: null, postId: null },
  /** @type {JobState|null} */
  job: null,
  /** @type {Settings} */
  settings: { ...DEFAULT_SETTINGS },
  /** @type {{ posts: number, comments: number, lastSavedAt: string|null }|null} */
  stats: null,
  starting: false,
  stopRequested: false,
};

const errMsg = (/** @type {any} */ err) => (err && err.message) || String(err);

/** @param {string} url @returns {TabInfo} */
function classify(url) {
  try {
    return classifyTabUrl(url) || { kind: 'other', groupSlug: null, postId: null };
  } catch {
    return { kind: 'other', groupSlug: null, postId: null };
  }
}

/** @param {JobState|null|undefined} job */
const isActive = (job) => !!job && ACTIVE_STATUSES.has(job.status);

/** @param {unknown} n */
const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

// =============================================================================================
// Active tab

/**
 * The window this panel belongs to (each window has its own side panel). The panel follows that
 * window's active tab — never the last focused window's, which could be another window entirely.
 * @type {number|null}
 */
let panelWindowId = null;

async function resolvePanelWindow() {
  try {
    const win = await chrome.windows.getCurrent();
    panelWindowId = typeof win?.id === 'number' ? win.id : null;
  } catch {
    panelWindowId = null;
  }
}

/** The active tab of the panel's window. @returns {Promise<chrome.tabs.Tab|null>} */
async function queryPanelTab() {
  try {
    const query = panelWindowId != null ? { active: true, windowId: panelWindowId } : { active: true, currentWindow: true };
    const [tab] = await chrome.tabs.query(query);
    return tab ?? null;
  } catch {
    return null;
  }
}

/**
 * Right before acting on the active tab: make sure it is still the tab the panel shows (same id
 * and kind of page). Otherwise refresh and return null so the caller does nothing.
 */
async function confirmPanelTab() {
  const tab = await queryPanelTab();
  const shown = state.tab;
  const kindOf = (t) => classify(t?.url || t?.pendingUrl || '').kind;
  if (!tab || !shown || tab.id !== shown.id || kindOf(tab) !== kindOf(shown)) {
    await refreshTab();
    showToast('The active tab changed — check it and try again.', { tone: 'warn' });
    return null;
  }
  return tab;
}

async function refreshTab() {
  const tab = await queryPanelTab();
  state.tab = tab ?? null;
  const url = tab?.url || tab?.pendingUrl || '';
  state.info = url ? classify(url) : { kind: 'other', groupSlug: null, postId: null };
  renderTab();
  updateControls();
  updateTabWarning();
  refreshPostSaved();
}

const refreshTabSoon = debounce(refreshTab, 120);

function renderTab() {
  const meta = TAB_KIND_META[/** @type {keyof TAB_KIND_META} */ (state.info.kind)] ?? TAB_KIND_META.other;
  const chip = $('tab-chip');
  chip.className = `badge chip tone-${meta.tone}`;
  $('tab-chip-label').textContent = meta.label;
  const group = state.info.groupSlug ? ` in group “${state.info.groupSlug}”` : '';
  chip.title = state.tab ? `Active tab: ${meta.label}${group}` : 'No active tab';

  const line = $('tab-line');
  const title = state.tab?.title || state.tab?.url || '';
  line.textContent = title;
  line.title = state.tab?.url || '';
  line.hidden = !title;
}

/** Shows the saved/unsaved status of the post open in the active tab. */
let postSavedToken = 0;
async function refreshPostSaved() {
  const box = $('post-saved');
  const token = ++postSavedToken;
  const { kind, postId } = state.info;
  if (kind !== 'post' || !postId) {
    box.hidden = true;
    return;
  }
  /** @type {any} */
  let post;
  try {
    post = await getPost(postId);
  } catch {
    post = undefined;
  }
  if (token !== postSavedToken) return; // tab changed meanwhile

  box.replaceChildren();
  box.hidden = false;
  if (!post) {
    box.className = 'saved-line is-unsaved';
    box.append(el('span', null, 'This post isn’t in your archive yet.'));
    return;
  }
  const saved = num(post.savedCommentCount);
  const expected = post.commentCountExpected;
  // The archive can hold more than Facebook counts now (comments deleted since an earlier save).
  const counts =
    typeof expected !== 'number'
      ? plural(saved, 'comment')
      : saved <= expected
        ? `${formatNumber(saved)} of ${plural(expected, 'comment')}`
        : `${plural(saved, 'comment')} (Facebook shows ${formatNumber(expected)})`;
  const partial = post.lastFullScanAt ? '' : ' · partial';
  box.className = 'saved-line';
  box.append(
    el(
      'span',
      {
        title: `Last saved ${formatDate(post.lastSavedAt)}${post.lastFullScanAt ? '' : ' — not fully scanned yet'}`,
      },
      `Saved ${counts} · ${relTime(post.lastSavedAt)}${partial}`,
    ),
    el(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        'aria-label': 'View this post in the library',
        onclick: () => openLibrary(postId).catch((e) => showToast(errMsg(e), { tone: 'danger' })),
      },
      'View',
    ),
  );
}

// =============================================================================================
// Buttons: enabled state + reasons

/**
 * Disables `btn` with `reason` as its tooltip, or enables it with its default tip.
 * @param {HTMLElement} btn @param {string|null} reason
 */
function setReason(btn, reason) {
  const b = /** @type {HTMLButtonElement} */ (btn);
  b.disabled = !!reason;
  b.title = reason || TIPS[/** @type {keyof TIPS} */ (b.id)] || '';
}

/** @param {HTMLElement} node @param {string|null} text */
function showReason(node, text) {
  node.textContent = text || '';
  node.hidden = !text;
}

function updateControls() {
  const { kind } = state.info;
  const fb = FB_KINDS.has(kind);
  const jobReason = state.starting
    ? 'Starting…'
    : isActive(state.job)
      ? 'A job is already running — stop it or wait for it to finish.'
      : null;
  const tabReason = state.tab ? null : 'No active tab found.';
  const postReason =
    kind === 'post'
      ? null
      : kind === 'mobile'
        ? MOBILE_REASON
        : fb
          ? 'Open a single post to save all of its comments (Quick save works on this page).'
          : 'Open a post in the group to save its comments.';
  const quickReason = fb ? null : kind === 'mobile' ? MOBILE_REASON : 'Switch to a Facebook tab first.';
  const crawlTabReason = fb
    ? null
    : kind === 'mobile'
      ? MOBILE_REASON
      : 'Switch to a www.facebook.com tab — the crawl runs in that tab.';
  const groupReason = groupUrlError(fieldOf('groupUrl').value) ? 'Fix the group URL first.' : null;

  setReason($('btn-save-post'), jobReason ?? tabReason ?? postReason);
  setReason($('btn-quick-save'), jobReason ?? tabReason ?? quickReason);
  setReason($('btn-crawl'), jobReason ?? tabReason ?? groupReason ?? crawlTabReason);
  setReason($('btn-open-group'), groupReason);

  // Visible explanations; "job running" is already obvious from the Progress card.
  showReason($('post-reason'), tabReason ?? postReason);
  showReason($('crawl-reason'), tabReason ?? crawlTabReason);
}

// =============================================================================================
// Jobs

/** @param {'quick'|'post'|'crawl'} mode @param {HTMLElement} button */
async function startJob(mode, button) {
  if (state.tab?.id == null) {
    showToast('No active tab.', { tone: 'danger' });
    return;
  }
  state.starting = true;
  button.setAttribute('aria-busy', 'true');
  updateControls();
  try {
    // Work on the tab the panel shows, and only if it is still this window's active tab.
    const tab = await confirmPanelTab();
    if (!tab) return;
    const tabId = /** @type {number} */ (tab.id);
    await saveNow(); // the worker reads settings from storage — persist pending edits first
    /** @type {{type: string, mode: string, tabId: number, overrides?: Partial<Settings>}} */
    const msg = { type: MSG.START_JOB, mode, tabId };
    if (mode === 'crawl') msg.overrides = pick(state.settings, CRAWL_KEYS);
    const res = await chrome.runtime.sendMessage(msg);
    if (!res || res.ok === false) throw new Error(res?.error || 'The background worker did not respond.');
    state.stopRequested = false;
    writeDismissed(null);
    await pullJob();
    $('progress-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showToast(`Couldn’t start: ${errMsg(err)}`, { tone: 'danger' });
  } finally {
    state.starting = false;
    button.removeAttribute('aria-busy');
    updateControls();
  }
}

async function stopJob() {
  state.stopRequested = true;
  renderJob(state.job);
  try {
    await chrome.runtime.sendMessage({ type: MSG.STOP_JOB });
  } catch (err) {
    state.stopRequested = false;
    renderJob(state.job);
    showToast(`Couldn’t stop the job: ${errMsg(err)}`, { tone: 'danger' });
  }
}

/** Reads the current JobState from the worker (GET_JOB), falling back to chrome.storage.session. */
async function pullJob() {
  const [fromWorker, fromStorage] = await Promise.all([
    Promise.resolve()
      .then(() => chrome.runtime.sendMessage({ type: MSG.GET_JOB }))
      .catch(() => null),
    Promise.resolve()
      .then(() => chrome.storage.session.get(JOB_STATE_KEY))
      .then((o) => o?.[JOB_STATE_KEY] ?? null)
      .catch(() => null),
  ]);
  const valid = (/** @type {any} */ j) => !!j && typeof j === 'object' && typeof j.status === 'string';
  const live = valid(fromWorker) ? fromWorker : valid(fromWorker?.state) ? fromWorker.state : null;
  const stored = valid(fromStorage) ? fromStorage : null;
  // Prefer the worker's live state, unless it is a blank idle state while storage remembers a job
  // (e.g. one marked "interrupted" after the worker restarted).
  renderJob(live && (live.status !== 'idle' || !stored) ? live : stored ?? live);
}

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** @param {string} t */
function clock(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '--:--:--' : clockFormat.format(d);
}

/** @param {JobState|null|undefined} job */
function renderJob(job) {
  const prev = state.job;
  const j = job && typeof job === 'object' && typeof job.status === 'string' ? job : null;
  state.job = j;
  const active = isActive(j);
  if (!active) state.stopRequested = false;
  updateControls();
  if (isActive(prev) && !active) {
    // A job just finished: refresh what it may have changed.
    refreshStats();
    refreshPostSaved();
  }

  const card = $('progress-card');
  const visible = !!j && j.status !== 'idle' && (active || !j.id || j.id !== readDismissed());
  card.hidden = !visible;
  if (!j || !visible) {
    stopTicker();
    return;
  }

  const meta = STATUS_META[/** @type {keyof STATUS_META} */ (j.status)] ?? { label: j.status, tone: 'neutral' };
  const badge = $('job-badge');
  badge.className = `badge tone-${meta.tone}`;
  badge.querySelector('.dot')?.classList.toggle('is-pulsing', active);
  $('job-badge-label').textContent = meta.label;
  $('job-phase').textContent = j.phase || meta.label;

  renderProgressBar(j, active);

  $('cnt-seen').textContent = formatNumber(num(j.commentsSeen));
  $('cnt-new').textContent = formatNumber(num(j.inserted));
  $('cnt-updated').textContent = formatNumber(num(j.updated));
  $('cnt-missing').textContent = formatNumber(num(j.markedMissing));
  $('cnt-failed').textContent = formatNumber(num(j.postsFailed));

  const current = $('job-current');
  if (active && j.currentPostUrl) {
    let path = j.currentPostUrl;
    try {
      path = new URL(j.currentPostUrl).pathname;
    } catch {
      /* keep raw */
    }
    current.textContent = `Current post: ${path}`;
    current.title = j.currentPostUrl;
    current.hidden = false;
  } else {
    current.hidden = true;
  }

  const errorBox = $('job-error');
  const errorText =
    j.error ||
    (j.status === 'interrupted'
      ? 'The extension’s background worker restarted, so this job stopped. Start it again — comments saved so far are kept.'
      : '');
  errorBox.textContent = errorText;
  errorBox.hidden = !errorText;

  const stop = /** @type {HTMLButtonElement} */ ($('btn-stop'));
  stop.hidden = !active;
  const stopping = j.status === 'stopping' || state.stopRequested;
  stop.disabled = stopping;
  stop.textContent = stopping ? 'Stopping…' : 'Stop';
  stop.title = stopping ? 'Finishing the current step, then stopping' : 'Stop after the current step';
  $('btn-dismiss').hidden = active;

  updateTabWarning();

  renderLog(j.log);
  renderJobMeta();
  if (active) startTicker();
  else stopTicker();
}

/** Warns when the tab a job is driving is not the visible tab (Facebook throttles hidden tabs). */
function updateTabWarning() {
  const j = state.job;
  const hidden = isActive(j) && j?.tabId != null && state.tab?.id !== j.tabId;
  $('job-tab-warning').hidden = !hidden;
}

/** @param {JobState} j @param {boolean} active */
function renderProgressBar(j, active) {
  const bar = $('job-bar');
  const fill = $('job-bar-fill');
  const total = num(j.postsTotal);
  const done = num(j.postsDone);
  const failed = num(j.postsFailed);
  bar.classList.remove('is-indeterminate', 'is-ok', 'is-danger', 'is-muted');

  let label = '';
  if (total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuemax', String(total));
    bar.setAttribute('aria-valuenow', String(Math.min(done, total)));
    bar.removeAttribute('aria-valuetext');
    label = `${formatNumber(done)} of ${plural(total, 'post')} done${failed ? ` · ${formatNumber(failed)} failed` : ''}`;
  } else {
    bar.removeAttribute('aria-valuenow');
    bar.setAttribute('aria-valuemax', '1');
    if (active) {
      bar.classList.add('is-indeterminate');
      fill.style.width = '';
      bar.setAttribute('aria-valuetext', 'Working');
      label = 'Working…';
    } else {
      fill.style.width = j.status === 'done' ? '100%' : '0%';
      bar.setAttribute('aria-valuetext', STATUS_META[/** @type {keyof STATUS_META} */ (j.status)]?.label ?? j.status);
    }
  }
  if (!active) bar.classList.add(j.status === 'done' ? 'is-ok' : j.status === 'error' ? 'is-danger' : 'is-muted');
  const labelNode = $('job-bar-label');
  labelNode.textContent = label;
  labelNode.hidden = !label;
}

/** "Group crawl · started 18:02 · running 1:23" — re-rendered every second while running. */
function renderJobMeta() {
  const j = state.job;
  const node = $('job-meta');
  if (!j) {
    node.textContent = '';
    return;
  }
  const parts = [MODE_LABEL[/** @type {keyof MODE_LABEL} */ (j.mode)] ?? 'Job'];
  const start = j.startedAt ? new Date(j.startedAt).getTime() : NaN;
  if (!Number.isNaN(start)) {
    parts.push(`started ${clock(/** @type {string} */ (j.startedAt))}`);
    if (isActive(j)) parts.push(`running ${formatDuration(Date.now() - start)}`);
    else if (j.finishedAt) {
      const end = new Date(j.finishedAt).getTime();
      if (!Number.isNaN(end)) parts.push(`took ${formatDuration(end - start)}`);
    }
  }
  node.textContent = parts.join(' · ');
}

/** @type {ReturnType<typeof setInterval>|null} */
let ticker = null;
function startTicker() {
  if (!ticker) ticker = setInterval(renderJobMeta, 1000);
}
function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

let logKey = '';
/** @param {JobState['log']} log */
function renderLog(log) {
  const list = $('job-log');
  const entries = Array.isArray(log) ? log : [];
  const last = entries[entries.length - 1];
  const key = `${entries.length}|${last?.t}|${last?.msg}`;
  if (key === logKey) return;
  logKey = key;

  // Auto-scroll only when the user hasn't scrolled up to read older entries.
  const stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 32;
  list.replaceChildren(
    ...entries.map((e) =>
      el(
        'li',
        { class: `lvl-${e.level || 'info'}` },
        el('time', { datetime: e.t, title: formatDate(e.t) }, clock(e.t)),
        el('span', { class: 'msg' }, e.msg ?? ''),
      ),
    ),
  );
  $('log-count').textContent = entries.length ? plural(entries.length, 'entry', 'entries') : '';
  if (stickToBottom) list.scrollTop = list.scrollHeight;
}

/** Hiding a finished job's card is remembered per job id (a per-viewer convenience). */
function readDismissed() {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}
/** @param {string|null|undefined} id */
function writeDismissed(id) {
  try {
    if (id) localStorage.setItem(DISMISSED_KEY, id);
    else localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* storage unavailable — the card simply stays visible */
  }
}

async function showJobTab() {
  const tabId = state.job?.tabId;
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    showToast(`Couldn’t switch to the tab: ${errMsg(err)}`, { tone: 'danger' });
  }
}

// =============================================================================================
// Archive

async function refreshStats() {
  try {
    const s = await getStats();
    state.stats = s;
    $('stat-posts').textContent = formatNumber(num(s.posts));
    $('stat-comments').textContent = formatNumber(num(s.comments));
    const last = $('stat-last');
    last.textContent = s.lastSavedAt ? relTimeShort(s.lastSavedAt) : 'Never';
    last.title = s.lastSavedAt ? formatDate(s.lastSavedAt) : 'Nothing saved yet';
  } catch (err) {
    state.stats = null;
    for (const id of ['stat-posts', 'stat-comments', 'stat-last']) $(id).textContent = '—';
    console.warn('Could not read archive stats', err);
  }
  updateExportButtons();
}

const refreshArchiveSoon = debounce(() => {
  refreshStats();
  refreshPostSaved();
}, 300);

const EXPORT_LABEL = {
  json: 'JSON',
  csv: 'CSV (opens in Excel / Sheets; import the id columns as Text — they have more digits than Excel keeps)',
  md: 'Markdown',
};

function exportButtons() {
  return /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[data-export]')]);
}

function updateExportButtons() {
  const empty = !!state.stats && state.stats.posts === 0;
  for (const btn of exportButtons()) {
    if (btn.getAttribute('aria-busy') === 'true') continue;
    btn.disabled = empty;
    btn.title = empty
      ? 'Nothing to export yet — save a post first'
      : `Download every saved post and comment as ${EXPORT_LABEL[/** @type {keyof EXPORT_LABEL} */ (btn.dataset.export)]}`;
  }
}

/** @param {HTMLButtonElement} btn */
async function onExport(btn) {
  const kind = /** @type {'json'|'csv'|'md'} */ (btn.dataset.export);
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    const r = await exportArchive(kind);
    showToast(`Exported ${plural(r.comments, 'comment')} from ${plural(r.posts, 'post')}.`, { tone: 'ok' });
  } catch (err) {
    showToast(errMsg(err), { tone: 'danger' });
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    updateExportButtons();
  }
}

// =============================================================================================
// Settings form (every [data-setting] input; saved with saveSettings, debounced)

/** @returns {(HTMLInputElement|HTMLSelectElement)[]} */
function settingInputs() {
  return [...document.querySelectorAll('[data-setting]')].map((n) => /** @type {any} */ (n));
}

/** @param {string} key @returns {HTMLInputElement} */
function fieldOf(key) {
  return /** @type {HTMLInputElement} */ (document.querySelector(`[data-setting="${key}"]`));
}

/** @template T @param {T} obj @param {string[]} keys */
function pick(obj, keys) {
  /** @type {any} */
  const out = {};
  for (const k of keys) out[k] = /** @type {any} */ (obj)[k];
  return out;
}

/** @param {string} source @returns {string|null} error message */
function patternError(source) {
  if (!String(source ?? '').trim()) return 'A pattern is required.';
  let re;
  try {
    re = new RegExp(source, 'i');
  } catch (err) {
    return errMsg(err);
  }
  const hit = FORBIDDEN_LABELS.find((label) => re.test(label));
  return hit ? `Too broad — it matches “${hit}”, which must never be clicked.` : null;
}

/**
 * Accepts full URLs, scheme-less URLs, post URLs, mobile URLs or a bare group name and returns
 * the canonical https://www.facebook.com/groups/<slug> when possible.
 * @param {string} raw
 */
function normalizeGroupUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^[\w.-]+$/.test(s) && !s.includes('.')) s = `https://www.facebook.com/groups/${s}`;
  else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return s;
  }
  if (/^(m|mbasic|touch|mobile)\.facebook\.com$/i.test(url.hostname)) url.hostname = 'www.facebook.com';
  const info = classify(url.toString());
  if ((info.kind === 'group' || info.kind === 'post') && info.groupSlug) {
    return `https://www.facebook.com/groups/${encodeURIComponent(info.groupSlug)}`;
  }
  return url.toString();
}

/** @param {string} raw @returns {string|null} */
function groupUrlError(raw) {
  const v = normalizeGroupUrl(raw);
  if (!v) return `Enter the group’s address, e.g. ${GROUP_URL_EXAMPLE}`;
  const info = classify(v);
  if ((info.kind === 'group' || info.kind === 'post') && info.groupSlug) return null;
  return 'That isn’t a Facebook group address — it should look like https://www.facebook.com/groups/<name>';
}

/** @param {HTMLInputElement|HTMLSelectElement} input @param {string|null} message */
function setFieldError(input, message) {
  const box = document.getElementById(`${input.id}-error`);
  if (box) {
    box.textContent = message || '';
    box.hidden = !message;
  }
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

/**
 * @param {HTMLInputElement|HTMLSelectElement} input
 * @returns {{ ok: true, value: any } | { ok: false }}
 */
function readField(input) {
  const kind = input.dataset.kind;
  if (input instanceof HTMLInputElement && input.type === 'checkbox') return { ok: true, value: input.checked };
  if (kind === 'number') {
    const raw = input.value.trim();
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
  }
  if (kind === 'pattern') {
    const v = input.value.trim();
    return patternError(v) ? { ok: false } : { ok: true, value: v };
  }
  if (kind === 'groupUrl') {
    return groupUrlError(input.value) ? { ok: false } : { ok: true, value: normalizeGroupUrl(input.value) };
  }
  return { ok: true, value: input.value };
}

/** @param {HTMLInputElement|HTMLSelectElement} input @param {any} value */
function setFieldValue(input, value) {
  if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = !!value;
  else input.value = value == null ? '' : String(value);
}

/**
 * Writes settings into the form. Unless `force`, skips the focused field, fields with unsaved
 * edits, and fields currently showing a validation error (so the user's text isn't lost).
 * @param {Settings} settings
 * @param {{ force?: boolean }} [opts]
 */
function fillForm(settings, { force = false } = {}) {
  for (const input of settingInputs()) {
    const key = /** @type {string} */ (input.dataset.setting);
    if (!force) {
      if (input === document.activeElement || key in pendingPatch) continue;
      if (input.getAttribute('aria-invalid') === 'true') continue;
    }
    setFieldValue(input, /** @type {any} */ (settings)[key]);
    if (force) setFieldError(input, null);
  }
  updateControls();
}

/** @type {Record<string, any>} */
let pendingPatch = {};
/** @type {Promise<void>} */
let saving = Promise.resolve();

const flushSave = debounce(() => {
  const patch = pendingPatch;
  pendingPatch = {};
  if (Object.keys(patch).length) saving = saving.then(() => persist(patch));
  return saving;
}, 400);

/** @param {Record<string, any>} patch */
async function persist(patch) {
  try {
    state.settings = await saveSettings(patch);
    fillForm(state.settings);
    flashSaved('Saved');
  } catch (err) {
    showToast(`Couldn’t save settings: ${errMsg(err)}`, { tone: 'danger' });
  }
}

/** @param {Record<string, any>} patch */
function queueSave(patch) {
  Object.assign(pendingPatch, patch);
  flushSave();
}

/** Persists any pending edits now and waits for in-flight saves. */
async function saveNow() {
  flushSave.flush();
  await saving;
}

/** @type {ReturnType<typeof setTimeout>|undefined} */
let savedTimer;
/** @param {string} text */
function flashSaved(text) {
  const node = $('settings-status');
  node.textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (node.textContent = ''), 1800);
}

/** @param {HTMLInputElement|HTMLSelectElement} input */
function onFieldEdit(input) {
  const kind = input.dataset.kind;
  if (kind === 'pattern' || kind === 'groupUrl') {
    // Errors first appear on blur; while typing, only update/clear an error that is already shown.
    if (input.getAttribute('aria-invalid') === 'true') {
      setFieldError(input, kind === 'pattern' ? patternError(input.value) : groupUrlError(input.value));
    }
    if (kind === 'groupUrl') updateControls();
  }
  const r = readField(input);
  if (r.ok) queueSave({ [/** @type {string} */ (input.dataset.setting)]: r.value });
}

/** @param {HTMLInputElement|HTMLSelectElement} input */
async function onFieldBlur(input) {
  const kind = input.dataset.kind;
  const key = /** @type {string} */ (input.dataset.setting);
  if (kind === 'pattern') {
    setFieldError(input, patternError(input.value));
  } else if (kind === 'groupUrl') {
    const err = groupUrlError(input.value);
    setFieldError(input, err);
    if (!err) input.value = normalizeGroupUrl(input.value);
    updateControls();
  } else if (kind === 'number') {
    // Show the clamped value (or restore the saved one if the field was left empty).
    await saveNow();
    if (document.activeElement !== input) setFieldValue(input, /** @type {any} */ (state.settings)[key]);
  }
}

/** Restores defaults for the Settings section only (the Group crawl fields are kept). */
async function resetSettings() {
  const defaults = pick(DEFAULT_SETTINGS, SECTION_KEYS);
  const patch = { ...pendingPatch, ...defaults };
  pendingPatch = {};
  flushSave.cancel();
  try {
    await saving;
    state.settings = await saveSettings(patch);
    for (const key of SECTION_KEYS) {
      const input = fieldOf(key);
      if (input) {
        setFieldValue(input, /** @type {any} */ (state.settings)[key]);
        setFieldError(input, null);
      }
    }
    updateControls();
    flashSaved('Defaults restored');
    showToast('Settings restored to defaults.', { tone: 'ok' });
  } catch (err) {
    showToast(`Couldn’t reset settings: ${errMsg(err)}`, { tone: 'danger' });
  }
}

/** Settings changed elsewhere (another panel, the worker): reflect them without clobbering edits. */
/** @param {any} stored */
function onExternalSettings(stored) {
  if (!stored || typeof stored !== 'object') return;
  state.settings = { ...DEFAULT_SETTINGS, ...stored };
  fillForm(state.settings);
}

// =============================================================================================
// Navigation

async function openGroup() {
  try {
    await saveNow();
    const url = buildGroupFeedUrl(state.settings);
    // Navigate only the tab the panel shows (this window's active tab); otherwise use a new tab.
    const current = await queryPanelTab();
    const tab = current && current.id === state.tab?.id ? current : null;
    const tabUrl = tab?.url || '';
    const reusable =
      tab?.id != null &&
      (FB_KINDS.has(state.info.kind) || state.info.kind === 'mobile' || /^chrome:\/\/newtab|^about:blank/.test(tabUrl)) &&
      !(isActive(state.job) && state.job?.tabId === tab.id); // never navigate the tab a job is driving
    if (reusable && tab?.id != null) await chrome.tabs.update(tab.id, { url });
    else await chrome.tabs.create({ url });
  } catch (err) {
    showToast(`Couldn’t open the group: ${errMsg(err)}`, { tone: 'danger' });
  }
}

// =============================================================================================
// Wiring

function bindEvents() {
  const savePost = $('btn-save-post');
  const quick = $('btn-quick-save');
  const crawl = $('btn-crawl');
  savePost.addEventListener('click', () => startJob('post', savePost));
  quick.addEventListener('click', () => startJob('quick', quick));
  crawl.addEventListener('click', () => startJob('crawl', crawl));
  $('btn-open-group').addEventListener('click', openGroup);
  $('btn-stop').addEventListener('click', stopJob);
  $('btn-show-tab').addEventListener('click', showJobTab);
  $('btn-dismiss').addEventListener('click', () => {
    writeDismissed(state.job?.id ?? null);
    $('progress-card').hidden = true;
    stopTicker();
  });
  $('btn-open-library').addEventListener('click', () =>
    openLibrary().catch((e) => showToast(errMsg(e), { tone: 'danger' })),
  );
  for (const btn of exportButtons()) btn.addEventListener('click', () => onExport(btn));
  $('btn-reset').addEventListener('click', resetSettings);

  for (const input of settingInputs()) {
    const isToggle = (input instanceof HTMLInputElement && input.type === 'checkbox') || input instanceof HTMLSelectElement;
    input.addEventListener(isToggle ? 'change' : 'input', () => onFieldEdit(input));
    input.addEventListener('blur', () => onFieldBlur(input));
  }

  // Active-tab tracking: only this panel's window matters (focus changes to other windows don't).
  chrome.tabs.onActivated.addListener((info) => {
    if (panelWindowId == null || info.windowId === panelWindowId) refreshTabSoon();
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if ((!state.tab || tabId === state.tab.id) && (change.url || change.title || change.status)) refreshTabSoon();
  });

  // Job state + settings mirrored from storage.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && JOB_STATE_KEY in changes) renderJob(changes[JOB_STATE_KEY].newValue ?? null);
    if (area === 'local' && SETTINGS_KEY in changes) onExternalSettings(changes[SETTINGS_KEY].newValue);
  });

  // Saved data changed (worker after each post, or the library after a delete).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === MSG.DB_CHANGED) refreshArchiveSoon();
    return undefined; // no async response
  });

  // Keep relative times ("5 minutes ago") fresh.
  setInterval(() => {
    refreshStats();
    refreshPostSaved();
  }, 60_000);
}

async function init() {
  await resolvePanelWindow();
  bindEvents();
  try {
    state.settings = await getSettings();
  } catch (err) {
    showToast(`Couldn’t load settings: ${errMsg(err)}`, { tone: 'danger' });
  }
  fillForm(state.settings, { force: true });
  await Promise.all([refreshTab(), pullJob(), refreshStats()]);
}

init();
