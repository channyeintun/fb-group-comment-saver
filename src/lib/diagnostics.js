// Privacy-safe diagnostics report for bug reports (SPEC §8 "Copy diagnostics"). Pure: no DOM, no
// chrome.*. The page part comes from src/page/diagnose.js (already masked there); this module
// masks the extension part (job log, user agent) the same way: no names, no post/comment text, no
// ids (digit runs of 5+ → {n}, pfbid… → {pfbid}) and no full URLs (reduced to masked shapes).

export const DIAG_FORMAT = 'fb-comment-saver/diagnostics-v1';
const LOG_LINES = 40;

/**
 * Ids → placeholders: digit runs of 5 or more → {n}; Facebook's opaque post ids (pfbid0…, accepted
 * as post ids from URLs, so they reach log lines as plain text) → {pfbid}.
 * @param {unknown} s
 */
export function maskDigits(s) {
  return String(s ?? '')
    .replace(/pfbid[0-9A-Za-z]+/gi, '{pfbid}')
    .replace(/\d{5,}/g, '{n}');
}

const SAFE_SEGMENT_RE =
  /^(groups|user|posts|permalink|photo|photos|photo\.php|profile\.php|story\.php|permalink\.php|l\.php|hashtag|watch|events|reel|reels|share|pages|people|media|set|videos|stories|discussion|members|about)$/i;

/**
 * Masked shape of a URL: host kept only as "fb"/"ext", group slug → {g}, digit runs ≥ 5 → {n},
 * other path segments → {s}, query keys only (no values, no __tracking keys).
 * @param {string} href
 */
export function urlShape(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return '{url}';
  }
  const segs = u.pathname.split('/');
  const path = segs
    .map((seg, i) => {
      if (!seg) return seg;
      if (i > 0 && segs[i - 1] === 'groups') return '{g}';
      if (/^\d+$/.test(seg)) return seg.length >= 5 ? '{n}' : seg;
      return SAFE_SEGMENT_RE.test(seg) ? seg.toLowerCase() : '{s}';
    })
    .join('/');
  const keys = [];
  for (const k of u.searchParams.keys()) {
    if (/^__/.test(k)) continue;
    const key = /^[a-z_]{1,30}$/i.test(k) ? k : '{k}';
    if (!keys.includes(key)) keys.push(key);
  }
  const host = /(^|\.)facebook\.com$/i.test(u.hostname) ? 'fb' : 'ext';
  return `${host}:${path}${keys.length ? `?${keys.join('&')}` : ''}`;
}

/**
 * One job log message without personal data: URLs → shapes, author names that the runner adds to
 * some lines → "(author)", digit runs ≥ 5 → {n}.
 * @param {string} msg
 */
export function maskLogLine(msg) {
  let s = String(msg ?? '');
  // Both patterns are anchored on the fixed text around the name and match any character in it:
  // a name can hold line breaks (a badge line under the name) or ": " ("Radio: FM Yangon").
  // "Post 2/4: <url> (Author Name)" — the crawl's per-post line.
  s = s.replace(/^(Post \d+\/\d+: )(\S+) \([\s\S]*\)$/, '$1$2 (author)');
  // "Skipped post #1 by Author Name: no post id found (3 comments not saved)." (normalize warning).
  s = s.replace(
    /^(Skipped post #\d+) by [\s\S]+(: no post id found \(\d+ comments? not saved\)\.)$/,
    '$1 by (author)$2',
  );
  s = s.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => urlShape(url));
  return maskDigits(s);
}

/**
 * Builds the report the side panel copies.
 * @param {{version?: string, userAgent?: string, language?: string, page?: any, pageNote?: string|null,
 *   job?: any, now?: string}} parts
 */
export function buildDiagnosticsReport({ version, userAgent, language, page = null, pageNote = null, job = null, now }) {
  /** @type {any} */
  let lastJob = null;
  if (job && typeof job === 'object' && typeof job.status === 'string') {
    const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
    const log = Array.isArray(job.log) ? job.log.slice(-LOG_LINES) : [];
    lastJob = {
      mode: job.mode ?? null,
      status: job.status,
      phase: job.phase ? maskLogLine(job.phase) : null,
      error: job.error ? maskLogLine(job.error) : null,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      counters: {
        postsTotal: num(job.postsTotal),
        postsDone: num(job.postsDone),
        postsFailed: num(job.postsFailed),
        commentsSeen: num(job.commentsSeen),
        inserted: num(job.inserted),
        updated: num(job.updated),
        markedMissing: num(job.markedMissing),
      },
      log: log.map((e) => ({ t: e?.t ?? null, level: e?.level ?? 'info', msg: maskLogLine(e?.msg ?? '') })),
    };
  }
  return {
    format: DIAG_FORMAT,
    createdAt: now ?? new Date().toISOString(),
    extension: version ?? null,
    userAgent: maskDigits(userAgent ?? ''),
    language: language ?? null,
    page,
    pageNote: pageNote ? maskLogLine(pageNote) : null,
    lastJob,
  };
}
