// Local archive in IndexedDB. See SPEC.md §6.
//
// Works in the MV3 service worker, extension pages and Node (fake-indexeddb) because it only
// touches `globalThis.indexedDB`. Promise wrappers are hand-written. Requests inside a transaction
// are only ever issued synchronously from the transaction body or from IDB request callbacks, never
// after awaiting a non-IDB promise, so transactions cannot auto-commit halfway through.

import { DB_NAME, DB_VERSION } from './constants.js';

/**
 * @typedef {Object} PostRecord
 * @property {string} id
 * @property {string|null} groupSlug
 * @property {string|null} url
 * @property {string|null} authorName
 * @property {string|null} authorId
 * @property {string|null} authorUrl
 * @property {string} text
 * @property {string|null} postedAt
 * @property {boolean} postedAtApprox
 * @property {string|null} postedAtText
 * @property {number|null} commentCountExpected
 * @property {'quick'|'post'|'crawl'} lastMode
 * @property {string} firstSavedAt
 * @property {string} lastSavedAt
 * @property {string|null} lastFullScanAt
 * @property {number} savedCommentCount
 */

/**
 * @typedef {Object} CommentRecord
 * @property {string} id
 * @property {string} postId
 * @property {string|null} groupSlug
 * @property {string} threadId
 * @property {string|null} parentId
 * @property {number} depth
 * @property {boolean} isReply
 * @property {string|null} replyToName
 * @property {'comment'|'reply'|null} replyToKind
 * @property {string|null} authorName
 * @property {string|null} authorId
 * @property {string|null} authorUrl
 * @property {string} text
 * @property {boolean} truncated
 * @property {string|null} createdAt
 * @property {boolean} createdAtApprox
 * @property {string|null} createdAtText
 * @property {string|null} relativeTime
 * @property {number} reactionCount
 * @property {Array<{type:'image'|'video'|'link', src?:string, href?:string|null, alt?:string}>} attachments
 * @property {string|null} permalink
 * @property {number} order
 * @property {string} firstSavedAt
 * @property {string} lastSavedAt
 * @property {string|null} missingAt
 * @property {Array<{text:string, savedAt:string|null}>} previousTexts
 */

/**
 * @typedef {Object} SaveResult
 * @property {number} inserted       incoming comments that were not stored yet
 * @property {number} updated        incoming comments whose stored record changed (besides lastSavedAt)
 * @property {number} unchanged      incoming comments identical to the stored record
 * @property {number} markedMissing  stored comments newly marked missing (fullScan only)
 * @property {number} total          stored comments of the post after the save (= savedCommentCount)
 * @property {boolean} [fullScanDowngraded]  only with `maxMissingRatio`: the full scan would have
 *                                   marked too many comments missing and was saved as a partial save
 * @property {number} [wouldMarkMissing]     only with `maxMissingRatio`: how many it would have marked
 */

const POSTS = 'posts';
const COMMENTS = 'comments';

/** A full scan is downgraded by `maxMissingRatio` only when it would mark at least this many. */
const MISSING_GUARD_MIN = 3;

/** How long an upgrade may stay blocked by another open connection before openDb() gives up. */
const BLOCKED_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------------------------------------------
// Connection

/**
 * @typedef {{promise: Promise<IDBDatabase>, db: IDBDatabase|null}} CachedConnection
 */

/**
 * One cached connection per realm, keyed by the factory it came from (so tests that swap
 * `globalThis.indexedDB` get their own connection).
 * @type {WeakMap<IDBFactory, CachedConnection>}
 */
const connections = new WeakMap();

/**
 * Open (or reuse) the database connection.
 * @returns {Promise<IDBDatabase>}
 */
export function openDb() {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('IndexedDB is not available in this context'));
  const existing = connections.get(factory);
  if (existing) return existing.promise;

  /** @type {CachedConnection} */
  const entry = { promise: /** @type {any} */ (null), db: null };
  const forget = () => {
    if (connections.get(factory) === entry) connections.delete(factory);
  };

  entry.promise = new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let blockedTimer = null;
    const req = factory.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      upgradeSchema(req.result, event.oldVersion);
    };

    req.onsuccess = () => {
      const db = req.result;
      if (blockedTimer) clearTimeout(blockedTimer);
      if (settled) {
        // We already gave up (blocked timeout); don't leak the late connection.
        db.close();
        return;
      }
      settled = true;
      // Another realm wants to upgrade/delete the DB: step aside so it is not blocked.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      // Closed by the browser (e.g. storage cleared): reopen on next use.
      db.onclose = forget;
      entry.db = db;
      resolve(db);
    };

    req.onerror = () => {
      if (blockedTimer) clearTimeout(blockedTimer);
      forget();
      if (!settled) {
        settled = true;
        reject(req.error || new Error('Failed to open IndexedDB'));
      }
    };

    // An older connection (another extension page) has not closed yet. Connections opened by this
    // module close themselves on versionchange, so normally this resolves on its own; give up after
    // a while instead of hanging forever.
    req.onblocked = () => {
      console.warn('[db] database upgrade is blocked by another open connection; waiting…');
      if (blockedTimer) return;
      blockedTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        forget();
        reject(
          new Error(
            'The archive database is in use by another extension page with an older version. ' +
              'Close other FB Comment Saver tabs and try again.',
          ),
        );
      }, BLOCKED_TIMEOUT_MS);
    };
  });

  connections.set(factory, entry);
  return entry.promise;
}

/**
 * Create/upgrade object stores. Runs inside the versionchange transaction.
 * @param {IDBDatabase} db
 * @param {number} oldVersion
 */
function upgradeSchema(db, oldVersion) {
  if (oldVersion < 1) {
    const posts = db.createObjectStore(POSTS, { keyPath: 'id' });
    posts.createIndex('lastSavedAt', 'lastSavedAt');
    posts.createIndex('groupSlug', 'groupSlug');

    const comments = db.createObjectStore(COMMENTS, { keyPath: 'id' });
    comments.createIndex('postId', 'postId');
    comments.createIndex('lastSavedAt', 'lastSavedAt');
    comments.createIndex('authorName', 'authorName');
  }
}

/**
 * Drop the cached connection if it is `db` (used when a cached connection turns out to be closed).
 * @param {IDBDatabase} db
 */
function forgetConnection(db) {
  const factory = globalThis.indexedDB;
  if (factory && connections.get(factory)?.db === db) connections.delete(factory);
}

// ------------------------------------------------------------------------------------------------
// Transaction helper

/**
 * @template T
 * @typedef {Object} TxContext
 * @property {IDBTransaction} tx
 * @property {(value: T) => void} setResult   value the returned promise resolves with on commit
 * @property {<A extends any[]>(fn: (...args: A) => void) => (...args: A) => void} guard
 *           wraps an IDB callback: a thrown error aborts the transaction and rejects the promise
 */

/**
 * Run `body` synchronously inside a new transaction. All further requests must be issued from
 * IDB callbacks wrapped with `guard`. Resolves (with the value given to `setResult`) once the
 * transaction has committed; rejects if it aborts.
 * @template T
 * @param {string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(ctx: TxContext<T>) => void} body
 * @returns {Promise<T>}
 */
async function runTx(storeNames, mode, body) {
  let db = await openDb();
  /** @type {IDBTransaction} */
  let tx;
  try {
    tx = db.transaction(storeNames, mode);
  } catch (err) {
    if (/** @type {any} */ (err)?.name !== 'InvalidStateError') throw err;
    // The cached connection was closed underneath us (versionchange / browser): reopen once.
    forgetConnection(db);
    db = await openDb();
    tx = db.transaction(storeNames, mode);
  }
  return executeTx(tx, body);
}

/**
 * @template T
 * @param {IDBTransaction} tx
 * @param {(ctx: TxContext<T>) => void} body
 * @returns {Promise<T>}
 */
function executeTx(tx, body) {
  return new Promise((resolve, reject) => {
    /** @type {any} */
    let result;
    /** @type {unknown} */
    let failure = null;

    /** @type {TxContext<T>['guard']} */
    const guard =
      (fn) =>
      (...args) => {
        try {
          fn(...args);
        } catch (err) {
          if (!failure) failure = err;
          try {
            tx.abort();
          } catch {
            // Already finished/aborting.
          }
        }
      };

    tx.oncomplete = () => resolve(result);
    tx.onabort = () =>
      reject(failure || tx.error || new DOMException('IndexedDB transaction aborted', 'AbortError'));

    guard(body)({ tx, guard, setResult: (value) => (result = value) });
  });
}

/**
 * Single read request on one store; resolves with the request result.
 * @template T
 * @param {string} storeName
 * @param {(store: IDBObjectStore) => IDBRequest<T>} makeRequest
 * @returns {Promise<T>}
 */
function readOne(storeName, makeRequest) {
  return runTx([storeName], 'readonly', ({ tx, guard, setResult }) => {
    const req = makeRequest(tx.objectStore(storeName));
    req.onsuccess = guard(() => setResult(req.result));
  });
}

// ------------------------------------------------------------------------------------------------
// Merge helpers (pure)

/**
 * A value that may overwrite a stored one: not null/undefined, not '', not an empty array.
 * @param {unknown} v
 */
function hasValue(v) {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/**
 * Structural equality for JSON-like records; null and undefined are treated as equal.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a == null && b == null) return true;
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * True if `after` differs from `before` in any field other than lastSavedAt.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 */
function changedIgnoringSaveTime(before, after) {
  return !deepEqual({ ...before, lastSavedAt: null }, { ...after, lastSavedAt: null });
}

/**
 * Text without a trailing ellipsis ("…" or "...") and surrounding whitespace — the visible prefix
 * of a truncated ("See more") text.
 * @param {string} text
 */
function truncatedPrefix(text) {
  return text.replace(/\s*(?:…|\.\.\.)?\s*$/, '');
}

/**
 * @param {unknown} value  ISO string, Date or epoch ms (anything else → current time)
 * @returns {string}
 */
function toIso(value) {
  if (typeof value === 'string' && value) return value;
  if (value instanceof Date || typeof value === 'number') return new Date(value).toISOString();
  return new Date().toISOString();
}

/**
 * Comment fields with special merge rules (everything else: incoming value wins if it hasValue).
 */
const COMMENT_SPECIAL_FIELDS = new Set([
  'id',
  'postId',
  'firstSavedAt',
  'lastSavedAt',
  'previousTexts',
  'text',
  'truncated',
  'missingAt',
]);

/**
 * Record for a comment that is not stored yet.
 * @param {CommentRecord} incoming
 * @param {string} postId
 * @param {string} now
 * @returns {CommentRecord}
 */
function newComment(incoming, postId, now) {
  return {
    ...incoming,
    postId,
    text: incoming.text ?? '',
    truncated: !!incoming.truncated,
    firstSavedAt: incoming.firstSavedAt || now,
    lastSavedAt: incoming.lastSavedAt || now,
    missingAt: null,
    previousTexts: Array.isArray(incoming.previousTexts) ? incoming.previousTexts : [],
  };
}

/**
 * Merge an incoming comment onto its stored record (SPEC §6).
 * @param {CommentRecord} stored
 * @param {CommentRecord} incoming
 * @param {string} postId
 * @param {string} now
 * @param {boolean} [keepOrder] keep the stored `order` (see savePostBundle)
 * @returns {CommentRecord}
 */
function mergeComment(stored, incoming, postId, now, keepOrder = false) {
  const merged = { ...stored };
  for (const [key, value] of Object.entries(incoming)) {
    if (!COMMENT_SPECIAL_FIELDS.has(key) && hasValue(value)) /** @type {any} */ (merged)[key] = value;
  }
  if (keepOrder && Number.isFinite(stored.order)) merged.order = stored.order;
  merged.postId = postId;
  merged.firstSavedAt = stored.firstSavedAt || incoming.firstSavedAt || now;
  merged.lastSavedAt = incoming.lastSavedAt || now;
  merged.missingAt = null; // seen again

  const previousTexts = Array.isArray(stored.previousTexts) ? [...stored.previousTexts] : [];
  const storedText = stored.text ?? '';
  const incomingText = incoming.text ?? '';
  const incomingTruncated = typeof incoming.truncated === 'boolean' ? incoming.truncated : null;

  if (!incomingText) {
    // Nothing usable (sticker/image-only or extraction miss): keep the stored text.
    merged.text = storedText;
    merged.truncated = !!stored.truncated;
  } else if (incomingText === storedText) {
    merged.text = storedText;
    merged.truncated = incomingTruncated ?? !!stored.truncated;
  } else if (incomingTruncated && storedText.startsWith(truncatedPrefix(incomingText))) {
    // Incoming is a "See more"-truncated view of the text we already have in full.
    merged.text = storedText;
    merged.truncated = !!stored.truncated;
  } else if (stored.truncated && incomingText.startsWith(truncatedPrefix(storedText))) {
    // We only had a truncated view before; this is its expansion, not an edit.
    merged.text = incomingText;
    merged.truncated = !!incomingTruncated;
  } else {
    // Edited: keep the old version.
    if (storedText) previousTexts.push({ text: storedText, savedAt: stored.lastSavedAt ?? null });
    merged.text = incomingText;
    merged.truncated = !!incomingTruncated;
  }
  merged.previousTexts = previousTexts;
  return merged;
}

/** Post fields with special merge rules. */
const POST_SPECIAL_FIELDS = new Set([
  'id',
  'firstSavedAt',
  'lastSavedAt',
  'lastMode',
  'lastFullScanAt',
  'savedCommentCount',
  'text',
]);

/**
 * Merge an incoming post onto its stored record (or build a new one) (SPEC §6).
 * @param {PostRecord|undefined} stored
 * @param {PostRecord} incoming
 * @param {{fullScan: boolean, now: string, savedCommentCount: number}} opts
 * @returns {PostRecord}
 */
function mergePost(stored, incoming, { fullScan, now, savedCommentCount }) {
  /** @type {any} */
  let merged;
  if (!stored) {
    merged = { ...incoming, text: incoming.text ?? '' };
  } else {
    merged = { ...stored };
    for (const [key, value] of Object.entries(incoming)) {
      if (!POST_SPECIAL_FIELDS.has(key) && hasValue(value)) merged[key] = value;
    }
    // Text: a non-empty incoming text wins, unless it is merely a shorter prefix of the stored
    // text (feed preview truncated by "See more" / "…").
    const storedText = stored.text ?? '';
    const incomingText = incoming.text ?? '';
    const isShorterPrefix =
      incomingText.length < storedText.length && storedText.startsWith(truncatedPrefix(incomingText));
    merged.text = incomingText && !isShorterPrefix ? incomingText : storedText;
  }
  merged.id = incoming.id;
  merged.firstSavedAt = stored?.firstSavedAt || incoming.firstSavedAt || now;
  merged.lastSavedAt = incoming.lastSavedAt || now;
  merged.lastMode = incoming.lastMode ?? stored?.lastMode ?? null;
  merged.lastFullScanAt = fullScan ? now : (stored?.lastFullScanAt ?? incoming.lastFullScanAt ?? null);
  merged.savedCommentCount = savedCommentCount;
  return merged;
}

/**
 * Spreads `count` values evenly strictly between `lo` and `hi`.
 * @param {number} lo @param {number} hi @param {number} count
 */
function between(lo, hi, count) {
  return Array.from({ length: count }, (_, k) => lo + ((k + 1) * (hi - lo)) / (count + 1));
}

/** Smallest value in sorted `orders` above `x`, else x + 1. */
function nextAbove(orders, x) {
  for (const o of orders) if (o > x) return o;
  return x + 1;
}

/** Largest value in sorted `orders` below `x`, else x - 1. */
function prevBelow(orders, x) {
  for (let i = orders.length - 1; i >= 0; i--) if (orders[i] < x) return orders[i];
  return x - 1;
}

/**
 * Orders for incoming comments that are not stored under this post yet, when stored orders are
 * kept (a partial save of a fully scanned post). A partial save numbers only what was visible, so
 * its indexes say nothing about the stored thread order. Instead each run of new comments is
 * placed right after the stored comment that precedes it in this save's DOM order (strictly before
 * the next stored comment); a run before any stored one goes right before the first one that follows.
 * @param {CommentRecord[]} list  incoming comments in DOM order
 * @param {Map<string, CommentRecord>} storedOfPost
 * @returns {Map<string, number>} id → order
 */
function placeNewComments(list, storedOfPost) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const orders = [...storedOfPost.values()]
    .map((r) => r.order)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!orders.length) return out; // nothing to anchor to: the incoming numbering stands
  const anchorOf = (c) => {
    const s = storedOfPost.get(c.id);
    return s && Number.isFinite(s.order) ? s.order : null;
  };

  /** @type {number|null} */
  let prevAnchor = null;
  let i = 0;
  while (i < list.length) {
    const a = anchorOf(list[i]);
    if (a !== null) {
      prevAnchor = a;
      i++;
      continue;
    }
    /** @type {string[]} */
    const run = [];
    let j = i;
    for (; j < list.length && anchorOf(list[j]) === null; j++) {
      if (!run.includes(list[j].id) && !out.has(list[j].id)) run.push(list[j].id);
    }
    let lo;
    let hi;
    if (prevAnchor !== null) {
      lo = prevAnchor;
      hi = nextAbove(orders, lo);
    } else {
      hi = j < list.length ? /** @type {number} */ (anchorOf(list[j])) : orders[0];
      lo = prevBelow(orders, hi);
    }
    between(lo, hi, run.length).forEach((order, k) => out.set(run[k], order));
    i = j;
  }
  return out;
}

/**
 * New orders for stored comments that a renumbering save did not see (missing on a full scan, or
 * collapsed in a partial save before any full scan): each keeps its place after the comment that
 * preceded it before, in that comment's new numbering, instead of a stale index that would now tie
 * with (or sort before) other comments.
 * @param {Map<string, CommentRecord>} storedOfPost
 * @param {Map<string, number>} newOrderOf  id → order of every comment in this save
 * @returns {Map<string, number>} id → order for unseen comments
 */
function reanchorUnseen(storedOfPost, newOrderOf) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const newOrders = [...newOrderOf.values()].filter(Number.isFinite).sort((a, b) => a - b);
  if (!newOrders.length) return out;
  const old = [...storedOfPost.values()]
    .filter((r) => Number.isFinite(r.order))
    .sort((a, b) => a.order - b.order || compareAsc(a.id, b.id));
  /** @type {number|null} */
  let pred = null;
  /** @type {string[]} */
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const lo = pred !== null ? pred : newOrders[0] - 1;
    const hi = pred !== null ? nextAbove(newOrders, pred) : newOrders[0];
    between(lo, hi, run.length).forEach((order, k) => out.set(run[k], order));
    run = [];
  };
  for (const r of old) {
    const seen = newOrderOf.get(r.id);
    if (seen === undefined) {
      run.push(r.id);
    } else {
      flush();
      pred = Number.isFinite(seen) ? seen : pred;
    }
  }
  flush();
  return out;
}

// ------------------------------------------------------------------------------------------------
// Public API

/**
 * Save one post and its comments atomically (one readwrite transaction over both stores) with the
 * merge semantics of SPEC §6.
 *
 * `maxMissingRatio` (optional safety net): a full scan that would newly mark at least 3 stored
 * comments missing, and more than this share of the post's stored non-missing comments, is saved
 * as a partial save instead (no missing marks, no lastFullScanAt); the result then reports
 * `fullScanDowngraded` and `wouldMarkMissing`.
 * @param {PostRecord} post
 * @param {CommentRecord[]} comments
 * @param {{fullScan?: boolean, now?: string, maxMissingRatio?: number}} [options]
 * @returns {Promise<SaveResult>}
 */
export async function savePostBundle(post, comments, options = {}) {
  if (!post || typeof post.id !== 'string' || !post.id) {
    throw new TypeError('savePostBundle: post.id (string) is required');
  }
  const list = Array.isArray(comments) ? comments : [];
  for (const c of list) {
    if (!c || typeof c.id !== 'string' || !c.id) {
      throw new TypeError('savePostBundle: every comment needs an id (string)');
    }
  }
  const requestedFullScan = !!options.fullScan;
  const maxMissingRatio = typeof options.maxMissingRatio === 'number' ? options.maxMissingRatio : null;
  const now = toIso(options.now);
  const postId = post.id;
  const incomingIds = [...new Set(list.map((c) => c.id))];

  return runTx([POSTS, COMMENTS], 'readwrite', ({ tx, guard, setResult }) => {
    const postStore = tx.objectStore(POSTS);
    const commentStore = tx.objectStore(COMMENTS);

    // Requests in a transaction complete in the order they were issued, so when the last read's
    // callback runs, every earlier read has its result.
    const postReq = postStore.get(postId);
    const byPostReq = commentStore.index('postId').getAll(postId);

    byPostReq.onsuccess = guard(() => {
      /** @type {Map<string, CommentRecord>} stored comments of this post */
      const storedOfPost = new Map(byPostReq.result.map((c) => [c.id, c]));
      // Incoming ids not found under this post may still exist (stored under another post id):
      // fetch them so their history is merged rather than overwritten.
      const unknownIds = incomingIds.filter((id) => !storedOfPost.has(id));
      /** @type {Map<string, CommentRecord>} */
      const storedElsewhere = new Map();
      if (unknownIds.length === 0) {
        writeBundle(storedOfPost, storedElsewhere);
        return;
      }
      let pending = unknownIds.length;
      for (const id of unknownIds) {
        const req = commentStore.get(id);
        req.onsuccess = guard(() => {
          if (req.result) storedElsewhere.set(id, req.result);
          if (--pending === 0) writeBundle(storedOfPost, storedElsewhere);
        });
      }
    });

    /**
     * Compute merged records and issue all writes (synchronously, from an IDB callback).
     * @param {Map<string, CommentRecord>} storedOfPost
     * @param {Map<string, CommentRecord>} storedElsewhere
     */
    function writeBundle(storedOfPost, storedElsewhere) {
      /** @type {SaveResult} */
      const counts = { inserted: 0, updated: 0, unchanged: 0, markedMissing: 0, total: 0 };
      const incomingSet = new Set(incomingIds);

      // Safety net: a "full" scan that would suddenly mark many comments missing is not trusted.
      let fullScan = requestedFullScan;
      let wouldMarkMissing = 0;
      if (requestedFullScan) {
        let active = 0;
        for (const [id, record] of storedOfPost) {
          if (record.missingAt != null) continue;
          active++;
          if (!incomingSet.has(id)) wouldMarkMissing++;
        }
        if (maxMissingRatio !== null && wouldMarkMissing >= MISSING_GUARD_MIN && wouldMarkMissing > maxMissingRatio * active) {
          fullScan = false;
        }
      }

      // `order` is the comment's index in the DOM of *that* save. A partial save (quick save, feed
      // preview, incomplete scan) numbers only what was visible, so once the post has had a full
      // scan, only another full scan may renumber stored comments — otherwise replies would sort
      // under the wrong parent in exports. Comments new to the post are then slotted in after their
      // DOM predecessor. (postReq has completed: requests finish in order.)
      const keepOrder = !fullScan && !!postReq.result?.lastFullScanAt;
      const placed = keepOrder ? placeNewComments(list, storedOfPost) : new Map();

      // Merge incoming comments; duplicates of the same id merge sequentially.
      /** @type {Map<string, CommentRecord>} */
      const merged = new Map();
      for (const incoming of list) {
        const base = merged.get(incoming.id) ?? storedOfPost.get(incoming.id) ?? storedElsewhere.get(incoming.id);
        const record = base ? mergeComment(base, incoming, postId, now, keepOrder) : newComment(incoming, postId, now);
        if (placed.has(incoming.id)) record.order = /** @type {number} */ (placed.get(incoming.id));
        merged.set(incoming.id, record);
      }
      for (const [id, record] of merged) {
        const original = storedOfPost.get(id) ?? storedElsewhere.get(id);
        if (!original) counts.inserted++;
        else if (changedIgnoringSaveTime(original, record)) counts.updated++;
        else counts.unchanged++;
        commentStore.put(record);
      }

      // Stored comments this save did not see: when the save renumbered the post, they keep their
      // place after their previous neighbour; on a full scan they are also marked missing (never
      // deleted).
      const reanchored = keepOrder
        ? new Map()
        : reanchorUnseen(storedOfPost, new Map([...merged].map(([id, r]) => [id, r.order])));
      for (const [id, record] of storedOfPost) {
        if (merged.has(id)) continue;
        const next = { ...record };
        if (reanchored.has(id)) next.order = /** @type {number} */ (reanchored.get(id));
        if (fullScan && record.missingAt == null) {
          next.missingAt = now;
          counts.markedMissing++;
        }
        if (next.order !== record.order || next.missingAt !== record.missingAt) commentStore.put(next);
      }

      const ids = new Set([...storedOfPost.keys(), ...merged.keys()]);
      counts.total = ids.size;
      postStore.put(mergePost(postReq.result, post, { fullScan, now, savedCommentCount: counts.total }));
      if (maxMissingRatio !== null) {
        counts.fullScanDowngraded = requestedFullScan && !fullScan;
        counts.wouldMarkMissing = wouldMarkMissing;
      }
      setResult(counts);
    }
  });
}

/**
 * All posts, most recently saved first.
 * @returns {Promise<PostRecord[]>}
 */
export async function listPosts() {
  /** @type {PostRecord[]} */
  const posts = await readOne(POSTS, (store) => store.getAll());
  return posts.sort((a, b) => compareDesc(a.lastSavedAt, b.lastSavedAt) || compareAsc(a.id, b.id));
}

/**
 * @param {string} id
 * @returns {Promise<PostRecord|undefined>}
 */
export async function getPost(id) {
  return readOne(POSTS, (store) => store.get(id));
}

/**
 * Comments of one post in thread order (`order` asc, then createdAt).
 * @param {string} postId
 * @returns {Promise<CommentRecord[]>}
 */
export async function getComments(postId) {
  /** @type {CommentRecord[]} */
  const comments = await readOne(COMMENTS, (store) => store.index('postId').getAll(postId));
  return comments.sort(compareCommentOrder);
}

/**
 * Every stored comment, grouped by post (postId asc) and in thread order within a post.
 * @returns {Promise<CommentRecord[]>}
 */
export async function getAllComments() {
  /** @type {CommentRecord[]} */
  const comments = await readOne(COMMENTS, (store) => store.getAll());
  return comments.sort((a, b) => compareAsc(a.postId, b.postId) || compareCommentOrder(a, b));
}

/**
 * Case-insensitive substring search over comment text and author name.
 * Results: newest comment first (createdAt desc, unknown dates last), at most `limit`.
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {Promise<CommentRecord[]>}
 */
export async function searchComments(query, { limit = 500 } = {}) {
  const needle = foldForSearch(query).trim();
  if (!needle) return [];

  /** @type {CommentRecord[]} */
  const matches = await runTx([COMMENTS], 'readonly', ({ tx, guard, setResult }) => {
    /** @type {CommentRecord[]} */
    const found = [];
    const req = tx.objectStore(COMMENTS).openCursor();
    req.onsuccess = guard(() => {
      const cursor = req.result;
      if (!cursor) {
        setResult(found);
        return;
      }
      const c = /** @type {CommentRecord} */ (cursor.value);
      if (foldForSearch(c.text).includes(needle) || foldForSearch(c.authorName).includes(needle)) {
        found.push(c);
      }
      cursor.continue();
    });
  });

  matches.sort(
    (a, b) => compareDesc(a.createdAt, b.createdAt) || compareAsc(a.postId, b.postId) || compareCommentOrder(a, b),
  );
  return matches.slice(0, Math.max(0, limit));
}

/**
 * @returns {Promise<{posts: number, comments: number, lastSavedAt: string|null}>}
 */
export async function getStats() {
  return runTx([POSTS, COMMENTS], 'readonly', ({ tx, guard, setResult }) => {
    const stats = { posts: 0, comments: 0, lastSavedAt: /** @type {string|null} */ (null) };
    const postCount = tx.objectStore(POSTS).count();
    const commentCount = tx.objectStore(COMMENTS).count();
    // Newest lastSavedAt = first entry of the index walked backwards.
    const latest = tx.objectStore(POSTS).index('lastSavedAt').openCursor(null, 'prev');
    postCount.onsuccess = guard(() => (stats.posts = postCount.result));
    commentCount.onsuccess = guard(() => (stats.comments = commentCount.result));
    latest.onsuccess = guard(() => {
      stats.lastSavedAt = latest.result ? latest.result.value.lastSavedAt : null;
    });
    setResult(stats);
  });
}

/**
 * Delete a post and all of its comments.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deletePost(id) {
  await runTx([POSTS, COMMENTS], 'readwrite', ({ tx, guard }) => {
    const commentStore = tx.objectStore(COMMENTS);
    tx.objectStore(POSTS).delete(id);
    const keysReq = commentStore.index('postId').getAllKeys(id);
    keysReq.onsuccess = guard(() => {
      for (const key of keysReq.result) commentStore.delete(key);
    });
  });
}

/**
 * Remove everything from the archive.
 * @returns {Promise<void>}
 */
export async function clearAll() {
  await runTx([POSTS, COMMENTS], 'readwrite', ({ tx }) => {
    tx.objectStore(POSTS).clear();
    tx.objectStore(COMMENTS).clear();
  });
}

/**
 * Ids of posts whose last full scan happened at or after `ms`.
 * @param {number|Date|string} ms  epoch milliseconds (Date / ISO string accepted too)
 * @returns {Promise<Set<string>>}
 */
export async function postsScannedSince(ms) {
  const threshold = ms instanceof Date ? ms.getTime() : typeof ms === 'string' ? Date.parse(ms) : Number(ms);
  /** @type {PostRecord[]} */
  const posts = await readOne(POSTS, (store) => store.getAll());
  const ids = new Set();
  for (const p of posts) {
    if (!p.lastFullScanAt) continue;
    const t = Date.parse(p.lastFullScanAt);
    if (!Number.isNaN(t) && t >= threshold) ids.add(p.id);
  }
  return ids;
}

// ------------------------------------------------------------------------------------------------
// Sorting / search helpers

/**
 * Ascending comparison; null/undefined sort last.
 * @param {any} a
 * @param {any} b
 */
function compareAsc(a, b) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Descending comparison; null/undefined sort last.
 * @param {any} a
 * @param {any} b
 */
function compareDesc(a, b) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  return a > b ? -1 : a < b ? 1 : 0;
}

/**
 * @param {CommentRecord} a
 * @param {CommentRecord} b
 */
function compareCommentOrder(a, b) {
  return compareAsc(a.order, b.order) || compareAsc(a.createdAt, b.createdAt) || compareAsc(a.id, b.id);
}

/**
 * Normalize text for case-insensitive matching (NFC so composed/decomposed forms compare equal).
 * @param {unknown} value
 */
function foldForSearch(value) {
  if (value == null) return '';
  return String(value).normalize('NFC').toLowerCase();
}
