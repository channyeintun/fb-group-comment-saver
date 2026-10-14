# FB Group Comment Saver — Design Spec (source of truth for all modules)

Chrome MV3 extension that saves comments (and replies) from posts in the Facebook group
`https://www.facebook.com/groups/myanmarsoftwareengineers` (any group works; that one is the default)
into a local IndexedDB archive, with a library viewer and JSON / CSV / Markdown export.

User actions on Facebook (opening the sort menu, choosing "All comments", clicking "View N replies",
"View more comments", "See more", scrolling) are performed with **Playwright running inside the
extension** via [`playwright-crx`](https://github.com/ruifigueira/playwright-crx) (`chrome.debugger`
transport). Extraction is a self-contained page function run with `page.evaluate` (or
`chrome.scripting.executeScript` for the no-automation "quick save").

Plain JavaScript (ES modules, JSDoc types), bundled by esbuild. No TypeScript, no frameworks.

---------------------------------------------------------------------------------------------------

## 1. Observed Facebook DOM facts (verified live on 2026-10-14, English UI, www.facebook.com)

These are facts, not guesses. Code must be built around them.

### Group feed (`/groups/<slug>` or `/groups/<slug>/?sorting_setting=...`)
- Feed container: `[role="feed"]`. Each post is a top-level `[role="article"]` **without** `aria-label`
  (it has `aria-labelledby="_r_3h_ _r_3i_ ..."`). "Top-level" = no ancestor `[role="article"]`.
- **The feed is virtualized**: posts scrolled far off-screen keep their wrapper but their content is
  emptied (innerText `""`, no links). Permalinks must be collected incrementally *while* scrolling.
  New posts are appended on scroll (DOM count grew 9→13→17→…→36 with `scrollBy(0, 2*innerHeight)` +
  1.8 s waits).
- Post permalink: the header's timestamp `<a>`, owned by the post (not inside a comment article),
  **before** the post body, whose href matches `/groups/<slug>/posts/<postId>/…` (sometimes
  `/groups/<slug>/permalink/<postId>/`). Its text is the relative time or date ("6h", "1d",
  "6 October at 21:43"). Present for ~35/36 posts observed; a post may lack it (lazy href `#` until
  hovered). Links inside the body (pasted facebook.com URLs are direct hrefs, not l.facebook.com)
  or after it (attachments, a shared post) can point at *other* posts and are never the permalink.
- Live (2026-10-14): `collectFeedPosts` + scrolling found 25 unique posts in 7 scroll rounds with
  0 missing hrefs; quick-save `extractRaw` on the feed read 12 rendered posts and 8 preview comments,
  all with ids, dates and text.
- Live (owner's account, re-verified): a feed post article is `[role=article]` with `aria-labelledby`,
  **no** `aria-label`, **no** `aria-posinset`. Its header links, in order: avatar
  `/groups/{g}/user/{n}/` (tabindex -1, no text), `/groups/{g}/user/{n}/` (aria-label, no text),
  author `/groups/{g}/user/{n}/` (text), permalink `/groups/{g}/posts/{n}/?__cft__…` (short text like
  "6h", has **both** `aria-label` and `aria-labelledby`).
- **Markup differs per account** (A/B experiments): on another user's Mac (English UI, looks the same)
  a group crawl found the feed (`[role=feed] [role=article]` present) but 0 post links in 6 scrolls.
  Unverified candidates: header links stay `href="#"` until hovered (and lose it on mouseout), posts
  without `role=article` or with an `aria-label`, several `[role=feed]`s, another extension rewriting
  the DOM. Hence several id sources, language-independent rules, and "Copy diagnostics" (§4.5, §8).

### React data (fibers) — verified live
- React's fiber is reachable as `el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]` (walk
  up with `.return`) **only from the page's MAIN world**. Expando properties are per JS world: from an
  isolated world (`chrome.scripting.executeScript`'s default; content scripts) they are invisible.
  Playwright's `page.evaluate` (pw-driver, playwright-crx) runs in the MAIN world;
  `chrome.scripting.executeScript` needs `world: 'MAIN'`.
- **Feed post**: walking up from the post article, at fiber depth ~14, `memoizedProps.feedUnit.id`
  (also `feedUnit.__id`) is base64 of `"S:_I<digits>:VK:<postId>"`. The VK number equals the post id of
  the permalink (18/18 posts); the `_I` number is NOT the group id — ignore it.
- **Comment / reply article** (post dialog): ~4 fibers up, `memoizedProps.comment` has `legacy_fbid`
  (own raw id: comment id for top-level, reply id = `reply_comment_id` for replies),
  `id` = base64 of `"comment:<postId>_<ownId>"`, `author {id (numeric user id), name (as in the
  aria-label)}`, `attachments`, `preferred_body`. No thread/parent field and no `created_time` there.
- Post author: first `<a>` (not in a comment) whose href matches `/groups/<slug>/user/<userId>/` and
  has non-empty text. Anonymous participants appear with generated names (e.g. "BrightOtter3141").
- Post sub-parts carry `data-ad-rendering-role`: `profile_name`, `story_message` (post body),
  `like_button`, `comment_button`, `share_button`.
  Also present: `[data-ad-preview="message"]` / `[data-ad-comet-preview="message"]` on the body.
- Comment count: `[role="button"][aria-label="Leave a comment"]` whose innerText is the count (e.g. "20";
  empty for a post with 0 comments). Share count is `[aria-label="Share"]` with a number. **Do not**
  take "first numeric button" — that is wrong when a post has likes but no comments. The count
  includes replies (and hidden/deleted comments).
- Feed posts show only a comment *preview* plus buttons "View more comments" / "View more answers" /
  "View N replies". Full comments require opening the post.

### Post view (`/groups/<slug>/posts/<postId>/`)
- Navigating to a post URL opens it as a **modal `[role="dialog"]`** over a feed (the feed's
  `[role="main"]` is still in the DOM behind it, with its own articles — must be ignored).
  Pick the dialog that contains a post article (`[role="article"]` without `aria-label`, or one with
  post sub-parts — §4); if none, fall back to
  `[role="main"]` only when it shows a single post and no `[role="feed"]` (e.g. `/permalink/` layouts).
- **Loading a post URL directly** (fresh navigation, e.g. `page.goto` in a crawl) shows the post as a
  dialog over the user's **home news feed**, not the group feed. Until the dialog mounts,
  `[role="main"]` holds that feed (home-feed posts have no `/groups/` permalinks) — it must never be
  taken for the post. The dialog's "Close" button then navigates to `/` (home). When the post is
  opened from within the group feed (SPA click), Close returns to the group feed. Facebook also
  remembers expanded replies within the same SPA session.
- The comment area (count row, sort control) can render after the post body; loaders show a
  `[role="progressbar"]` while they run (slow on VPN connections, common in Myanmar).
- The dialog has one inner scroll container (`overflow-y: auto|scroll`, scrollHeight > clientHeight).
  **Comments load lazily** as that container scrolls; setting `scrollTop` alone was not verified to
  trigger loading — use real wheel events (Playwright `page.mouse.wheel`) over the dialog, and
  additionally `scrollIntoView` the last comment.
- Post date in dialog: there is no `/posts/` link (we are on it); the header shows e.g.
  `"4 October at 18:19"` (also reachable via the post's `aria-labelledby` ids). In the feed it is
  "5h"/"1d" text on the permalink link.
- Post author in dialog: first `/user/<id>/` link with text (the `profile_name` role holds the
  *group* name in the dialog header — do not use it as author).
- Empty state: text **"No comments yet"** inside the dialog when a post has 0 comments.
- Sort control: `[role="button"][aria-haspopup="menu"]` with innerText `"Most relevant"` (also
  "Newest", "All comments"); it holds only the text and an `aria-hidden` svg. `element.click()` opens
  `[role="menu"]` containing `[role="menuitem"]` items (no `aria-label`) whose text starts with
  "Most relevant", "Newest", "All comments" followed by a description line — textContent is the two
  concatenated, e.g. `"All commentsShow all comments, including potential spam."`, so item patterns
  are anchored at the start only. Choosing **"All comments"** then shows every top-level comment.
  After choosing, the sort button text becomes "All comments".
- Plain DOM `element.click()` works on all these controls (verified). Playwright clicks are preferred
  (trusted events + actionability), with DOM click as fallback (an open Messenger chat popup can
  cover the bottom-right of the post dialog and intercept pointer events). Chat popups are
  `[role="dialog"]` too, with a text box and message history.
- Live (2026-10-14, post 1600000000000001, after expansion): 19 of 20 counted comments extracted,
  3 indentation levels (left 370/431/473), all ids numeric, every `createdAt` exact from the
  timestamp aria-label (`"Sunday 4 October 2026 at 18:23"`, user's time zone Asia/Yangon UTC+6:30),
  Myanmar text and emoji intact, one fbcdn image attachment, canonical permalinks with tracking
  stripped; post author from its `/user/<id>/` link, dateText `"4 October at 18:19"`,
  commentCountExpected 20.

### Comment & reply articles
- Every comment/reply is `[role="article"]` **with** `aria-label`:
  - `"Comment by <Author> <relative time>"` e.g. `"Comment by Thura Min Oo 2 days ago"`
  - `"Reply by <Author> to <Other>'s comment <relative time>"`
  - `"Reply by <Author> to <Other>'s reply <relative time>"` (reply to a reply)
  (English UI. Detection of comment articles must not depend on the text: "has aria-label" is enough;
  posts use aria-labelledby — and own post sub-parts (`data-ad-rendering-role`, story message), which
  comments never do, so a post that also carries an aria-label on another account is still a post.)
- Comment articles are **descendants of the post article** (19/19 in dialog; also in feed preview).
- Replies are **NOT nested** inside their parent comment's article: all comment/reply articles are
  flat in DOM *pre-order* (a reply follows its parent; a reply-to-reply follows the reply).
- **Indentation encodes depth**: `getBoundingClientRect().left` was 370 (top-level), 431 (reply),
  473 (reply-to-reply) in one post. Depth = rank of distinct `left` values within that post.
- **Facebook caps indentation at depth 2**: a reply to a depth-2 reply is drawn at depth 2 as well
  (e.g. `"Reply by BrightOtter3141 to Nay Lin Htike's reply"` under Htet's depth-2 reply).
  The real parent is the replied-to reply named in the aria-label; depth stays visual.
- Inside a comment article (structure observed):
  ```
  div[role=article][aria-label="Comment by Thura Min Oo 2 days ago"]
    a[role=link][tabindex=-1] > svg            ← avatar link (href /groups/<slug>/user/<uid>/)
    a[role=link][tabindex=0] > span[dir=auto] "Thura Min Oo"   ← author link, same href
    span "·"
    a[role=link][aria-label="Sunday 11 October 2026 at 08:54"] > span[dir=auto] "2d"   ← timestamp/permalink
    span[dir=auto]                              ← BODY container
      div[dir=auto] "Hardly any degree exists…" ← one div per paragraph
      div[dir=auto] "Is there truly a degree…"
    div[role=button][aria-label="Hide or report this"]
    div[role=button][aria-label="Like"], [aria-label="React"], "Reply", "Share"
    [role=button][aria-label="5 reactions; see who reacted to this"]  (only when reacted; "1 reaction; …")
  ```
  Single-paragraph comments: `span[dir=auto] > div[dir=auto]` as well.
- Timestamp/permalink link href: `/groups/<slug>/posts/<postId>/?comment_id=<cid>&__cft__…`;
  replies additionally have `&reply_comment_id=<rid>`. For replies **and** replies-to-replies,
  `comment_id` = the top-level comment of the thread (thread root); `reply_comment_id` = own id.
  Its `aria-label` is the **absolute local date**: `"Sunday 4 October 2026 at 18:23"` (all 19 had it).
- Emoji are rendered as `<img alt="🍵" width=16 height=16>` in bodies **and** author names
  (e.g. "Chai_lover🍵"). Text extraction must substitute `img[alt]` with its alt text
  (innerText drops them).
- Small 16×16 imgs inside `[role=button]` are reaction icons — not attachments.
- Expander buttons (role=button, innerText): `"View 3 replies"`, `"View 1 reply"`,
  `"View more comments"`, `"View more answers"`, `"View previous comments"`, `"View all N replies"`.
  They have **no aria-label**; textContent is exactly the label and they contain only an
  `aria-hidden` svg. Labels such as "View 1 reply" repeat in many threads.
  Expanding is iterative: clicking "View 3 replies" can reveal 2 replies plus a nested
  "View 1 reply" (reply-to-reply). Loop until no expander remains (4 rounds sufficed for 14 comments).
  Never click "Hide replies" / "Hide".
- Truncated long text shows a `[role=button]` with innerText `"See more"` inside the body.
- A post's comment count may exceed what can be loaded (20 counted, 19 rendered — deleted/hidden).
  Store both "expected" and "saved" counts.
- Facebook may serve `web.facebook.com` (common in Myanmar) — same DOM. `m.facebook.com` is a
  different DOM and is unsupported.

---------------------------------------------------------------------------------------------------

## 2. Repository layout (each file has exactly one owner module)

```
package.json, build.mjs, README.md, .gitignore           [build]
src/manifest.json                                         [build]
src/page/extract.js   src/page/feed.js   src/page/probe.js   src/page/diagnose.js   [page]
tests/fixtures/*.html  tests/browser/page-scripts.test.mjs[page]
tests/browser/driver.test.mjs                             [background]
src/lib/constants.js  src/lib/settings.js                 [lib]
src/lib/fb-url.js  src/lib/fb-date.js  src/lib/normalize.js  src/lib/export.js  src/lib/diagnostics.js   [lib]
tests/unit/{settings,fb-url,fb-date,normalize,export,diagnostics}.test.mjs [lib]
src/lib/db.js   tests/unit/db.test.mjs                    [db]
src/background/service-worker.js  src/background/job-runner.js  src/background/pw-driver.js  [background]
src/ui/common.js src/ui/common.css src/ui/sidepanel.{html,css,js} src/ui/library.{html,css,js} [ui]
tests/e2e/extension.test.mjs                               [integration]
dist/  (build output — load this folder as the unpacked extension; gitignored)
```

Dependencies (all declared by [build] in package.json — others must not add any):
- `dependencies`: `playwright-crx` `0.15.0` (exact).
- `devDependencies`: `esbuild` `^0.28.2`, `playwright` `^1.64.0` (Node tests drive Chromium),
  `fake-indexeddb` `^6.0.0` (db unit tests).
- Tests use the built-in `node:test` + `node:assert/strict`. Scripts:
  `build` → `node build.mjs`; `watch` → `node build.mjs --watch`;
  `test` → `node --test "tests/unit/*.test.mjs"`; `test:browser` → `node --test "tests/browser/*.test.mjs"`;
  `test:e2e` → `npm run build && node --test --test-concurrency=1 "tests/e2e/*.test.mjs"`; `test:all` runs all three.
  (Since Node 21, `node --test <dir>/` treats the directory as a module and fails — always pass quoted globs.
  Glob arguments need Node 21+, so package.json declares `"engines": { "node": ">=22" }` and the
  README asks for Node.js 22 or newer.)

Import style: relative ES module imports with `.js` extension. UI and background code import from
`src/lib/*`. esbuild bundles:
- `src/background/service-worker.js` → `dist/background.js` (format `esm`, platform `browser`,
  target `chrome118` = `minimum_chrome_version`; manifest declares `"type": "module"`).
- `src/ui/sidepanel.js` → `dist/sidepanel.js`; `src/ui/library.js` → `dist/library.js` (format `esm`, same target).
- HTML/CSS copied flat to `dist/` (`sidepanel.html`, `library.html`, `common.css`, `sidepanel.css`,
  `library.css`). HTML references `./sidepanel.js` etc. with `<script type="module">`.
- **Never** enable `minify`/`keepNames` for code containing page functions (see §4 rule).

---------------------------------------------------------------------------------------------------

## 3. Shared constants & settings — `src/lib/constants.js`, `src/lib/settings.js`

```js
// constants.js
export const DB_NAME = 'fb-comment-saver';
export const DB_VERSION = 1;
export const EXPORT_FORMAT = 'fb-comment-saver/v1';
export const DEFAULT_GROUP_URL = 'https://www.facebook.com/groups/myanmarsoftwareengineers';
export const MSG = {
  START_JOB: 'START_JOB',   // UI → SW  {type, mode:'quick'|'post'|'crawl', tabId:number, overrides?:Partial<Settings>}
  STOP_JOB: 'STOP_JOB',     // UI → SW  {type}
  GET_JOB: 'GET_JOB',       // UI → SW  {type} → JobState
  DB_CHANGED: 'DB_CHANGED', // SW → all {type, postIds:string[]}
};
export const JOB_STATE_KEY = 'jobState';       // chrome.storage.session key
export const SETTINGS_KEY = 'settings';        // chrome.storage.local key
export const DEFAULT_SETTINGS = {
  groupUrl: DEFAULT_GROUP_URL,
  feedSort: 'CHRONOLOGICAL',       // 'CHRONOLOGICAL' | 'RECENT_ACTIVITY' | 'TOP_POSTS' | 'DEFAULT' → ?sorting_setting=
  maxPosts: 20,                    // crawl: number of posts to collect from the feed
  skipSavedWithinHours: 0,         // crawl: skip posts fully scanned within N hours (0 = never skip)
  sortAllComments: true,           // switch "Most relevant" → "All comments"
  expandReplies: true,             // click "View N replies"
  expandSeeMore: true,             // click "See more" in post/comment bodies
  actionDelayMs: 700,              // base delay between UI actions (+ random 0..50% jitter)
  maxExpandRounds: 40,             // per post
  postTimeoutSec: 240,             // per post hard cap for expansion
  returnToGroupAfterCrawl: true,
  expanderPattern: '^(view|see)( all| more| previous)?( \\d[\\d,.]*[km]?)?( more| previous)? (comments?|repl(y|ies)|answers?)\\b|^\\d[\\d,.]*[km]? (more )?repl(y|ies)$',
  seeMorePattern: '^see more$',
  sortButtonPattern: '^(most relevant|newest|all comments|top comments|most recent|oldest)$',
  sortAllItemPattern: '^all comments',
};
```
All `*Pattern` strings are compiled with flag `'i'` and tested against the element's innerText with
whitespace collapsed (`.replace(/\s+/g, ' ').trim()`). Patterns must **not** match "Hide replies".

`settings.js`:
```js
export async function getSettings(): Promise<Settings>      // {...DEFAULT_SETTINGS, ...stored}
export async function saveSettings(patch): Promise<Settings> // merges, validates numbers (clamp: maxPosts 1..500,
                                                             // skipSavedWithinHours 0..8760, actionDelayMs 100..10000,
                                                             // maxExpandRounds 1..200, postTimeoutSec 30..1800), returns merged
export function buildGroupFeedUrl(settings): string          // groupUrl with ?sorting_setting=<feedSort> unless 'DEFAULT'
export function isGroupFeedUrl(url, settings): boolean       // url already shows that feed: path /groups/<slug>[/discussion][/]
                                                             // (slug case-insensitive, any www/web host) and the same
                                                             // sorting_setting (none for 'DEFAULT'); other group pages → false
export function compilePatterns(settings): {expander:RegExp, seeMore:RegExp, sortButton:RegExp, sortAllItem:RegExp}
                                                             // invalid regex → fall back to DEFAULT_SETTINGS pattern
export function sanitizeSettings(partial): Settings          // pure: defaults filled, unknown keys dropped, numbers
                                                             // clamped, booleans/enums coerced, empty patterns → default
                                                             // (job-runner merges START_JOB overrides with it)
```
`saveSettings`/`getSettings` use `chrome.storage.local`. `buildGroupFeedUrl`, `isGroupFeedUrl` and
`compilePatterns` are pure (unit-tested).

---------------------------------------------------------------------------------------------------

## 4. Page scripts — `src/page/*.js`

**HARD RULE:** every exported page function is passed to `page.evaluate(fn, arg)` and
`chrome.scripting.executeScript({func: fn, args: [arg]})`, which serialize it with
`fn.toString()`. Therefore each exported page function must be **fully self-contained**: all helpers
are declared *inside* the function body; no references to imports, module-level variables, or other
functions; exactly one parameter (a plain JSON-serializable options object, may be `undefined`);
returns JSON-serializable data; uses no `async` unless necessary (allowed — both APIs await
promises). Write each as `export function name(opts) { … }`.

Shared DOM rules (re-implement inside each function as needed):
- Post sub-parts: `MESSAGE_SEL` and `[data-ad-rendering-role]` (body, profile_name, like/comment/share
  buttons). A comment never owns one.
- `isCommentArticle(el)`: `[role="article"][aria-label]` that owns no post sub-part (extractRaw's
  comment items; probePage's `commentCount`; pw-driver's `COMMENT_SEL` =
  `[role="article"][aria-label]:not(:has(<post sub-parts>))`).
- Post articles (dialog/main root selection): `[role="article"]` **without** `aria-label`, or **with** one
  and post sub-parts (some accounts may get aria-labelled posts, §1). A root holds one when it matches
  `ROOT_POST_SEL` = `[role="article"]:not([aria-label]), [role="article"] <post sub-part>` (pw-driver:
  `[role="dialog"]:has(…)` / `[role="main"]:has(…)`).
- Comment ownership (extractRaw items): a comment belongs to the nearest article above it that is the
  post itself or not a comment (`!ownsPostParts && (aria-label || comment-like)` is a comment) —
  so a post with or without `aria-label` owns its comments; a role-less feed container owns those not
  inside an article of its own.
- Lazy links: an `<a>` whose raw `href` is empty, starts with `#` or is `javascript:` has **no** href
  (`hrefOf` returns `''`): `a.href` would resolve `"#"` to the page URL, which names the open post and,
  on a notification URL, even carries `?comment_id=`. Applies in every page function.
- **Feed post containers** (collectFeedPosts, extractRaw's feed scope, diagnosePage): scan **every**
  `[role="feed"]` not inside a `[role="dialog"]` (fallback: all feeds; nested feeds only once). Per
  feed: top-level `[role="article"]`s (no ancestor article inside that feed) that are not
  comment-like; a feed that has content but yields no such article → its children (role-less post
  variant; a single wrapper child holding all posts is descended into). Only containers with content
  count. Comment-like article = it owns no post sub-part (`MESSAGE_SEL`, `[data-ad-rendering-role]`)
  **and** (its own links carry `comment_id`, or its fiber has `memoizedProps.comment` within 6 levels).
- `ownedBy(el, container)`: for an article container `el.closest('[role="article"]') === container`;
  for a role-less container: not inside a comment-like article of it.
- React data: fibers as in §1 (key prefix `__reactFiber$`; older React's `__reactInternalInstance$` is
  accepted too), every access in try/catch (never throw), walks capped at 80 levels and
  stopped at the feed element's own fiber; ids are accepted only when numeric. Page functions that read
  fibers return nulls when run outside the MAIN world.
- `textOf(el)`: text with `<img alt>` substituted by alt, `<br>` → `\n`, each `div[dir=auto]`
  paragraph separated by `\n`, whitespace inside lines collapsed, lines trimmed, ≥3 blank lines → 1.
  Implement by recursive walk of child nodes (not innerText) so it works on off-screen/hidden nodes.
  Exclude `[role="button"]` subtrees whose collapsed text matches `^see more$|^see less$` (the
  toggle itself) from body text.
- `ownedBy(el, article)`: `el.closest('[role="article"]') === article` (element belongs to that
  article and not to a nested one).
- Root selection (`findRoot()`): the **last** `[role="dialog"]` that contains a post article
  (`ROOT_POST_SEL`) → kind `'dialog'`; else if URL path matches
  `/groups/[^/]+/(posts|permalink)/` and `[role="main"]` shows a single post — no `[role="feed"]`
  inside and exactly one top-level post article with content — → kind `'main'` (a `[role="main"]`
  holding a feed is the home/group feed behind a post dialog that has not mounted yet, §1);
  else if `[role="feed"]` exists → kind `'feed'`; else `'none'`.
- Post body = `[data-ad-rendering-role="story_message"]`, `[data-ad-preview="message"]` or
  `[data-ad-comet-preview="message"]`. Links inside it are never the post's own links.

### 4.1 `extractRaw(opts)` — `src/page/extract.js`
`opts = { scope?: 'auto' | 'feed' }` (default 'auto'). With 'auto', uses `findRoot()`; for kind
`'dialog'|'main'` the result has exactly one post (the first top-level post article inside the root —
"top-level" relative to the root: no ancestor article inside root); for kind `'feed'` (or scope
'feed') it has one entry per **rendered** top-level feed post that has non-empty content.

Returns `RawExtraction`:
```js
{
  pageUrl: location.href,
  pageTitle: document.title,
  rootKind: 'dialog'|'main'|'feed'|'none',
  extractedAt: Date.now(),
  posts: [ RawPost ]
}
RawPost = {
  permalinkHref: string|null,   // absolute href (a.href) of a post-owned link (not in a comment, not in the
                                // body) matching /\/groups\/[^/]+\/(posts|permalink)\/[\w.-]+/ without comment_id:
                                // dialog/main (URL names a post id): only a link to that same id (the open post
                                //   has no link of its own; others belong to shared posts / link cards);
                                // feed: only links before the body (header), preferring one whose text is a
                                //   time/date; null if none (lazy href)
  authorName: string|null,      // textOf() of first post-owned link with href matching /\/user\/\d+|profile\.php\?id=|^https?:\/\/[^/]+\/[\w.]+\/?(\?|$)/ and non-empty text
  authorHref: string|null,      // that link's a.href
  text: string,                 // textOf() of post-owned [data-ad-rendering-role="story_message"] (fallback
                                // [data-ad-preview="message"], [data-ad-comet-preview="message"]); '' if none
  dateText: string|null,        // dialog/main: first post-owned span/a text (not in comment, not in body) matching
                                // /^(\d{1,2} \w+( \d{4})?|\w+ \d{1,2}(, \d{4})?|yesterday|today) at \d{1,2}:\d{2}( ?[ap]m)?$/i
                                // or /^\d+\s?[smhdwy]$/ or /^(just now|\d+ \w+ ago|an? \w+ ago)$/i ; feed: permalink link text
  dateAria: string|null,        // aria-label of the permalink link if present
  commentCountText: string|null,// innerText of post-owned [role=button][aria-label="Leave a comment"] if it has digits, else null
  emptyState: boolean,          // post-owned text node "No comments yet" exists
  fiberPostId: string|null,     // React data: feed story id's VK post id, walking up from the post article,
                                //   then its first header links, then (dialog/main) the root element
  items: [ RawComment ]         // comment articles (isCommentArticle) owned by this post (comment ownership
                                //   rule above), in DOM order
}
RawComment = {
  index: number,                // 0-based DOM order within the post
  ariaLabel: string,
  authorName: string|null,      // textOf() of the first comment-owned <a> with non-empty text that is not the
                                //   permalink (no 'comment_id'), comes before the permalink in document order,
                                //   is outside the body, and whose href is a profile link (/user/<id>,
                                //   profile.php?id=, facebook.com/<vanity>) or whose text equals the name in the
                                //   aria-label. null when none qualifies (name not a link): a mention, URL or
                                //   hashtag link is never the author; normalize falls back to the aria-label.
  authorHref: string|null,
  permalinkHref: string|null,   // a.href of the first comment-owned, non-lazy <a> whose href contains
                                //   'comment_id', outside the body (a pasted link to another comment is
                                //   never it) and — when fiberCommentId is known — whose own id
                                //   (reply_comment_id, else comment_id) equals fiberCommentId
  timeAria: string|null,        // that link's aria-label (without a permalink: the first comment-owned link
                                //   after the author, outside the body, with an aria-label and 1–16 chars of
                                //   text other than the author name — the href-less timestamp link)
  timeText: string|null,        // that link's collapsed text, e.g. "2d"
  text: string,                 // body: comment-owned span[dir=auto] or div[dir=auto] that (a) is not inside an <a>,
                                //   (b) not inside [role=button], (c) contains a div[dir=auto] child OR is the
                                //   largest-text such candidate; take the top-most matches (drop candidates
                                //   contained in another candidate), join with '\n'. '' if none (sticker/image-only).
  left: number,                 // Math.round(article.getBoundingClientRect().left)
  reactionLabel: string|null,   // aria-label of a comment-owned element with aria-label matching /\breactions?\b/i
  truncated: boolean,           // a comment-owned [role=button] matching ^see more$ exists
  fiberCommentId: string|null,  // React data (null when unavailable): comment.legacy_fbid (own id); else the
                                //   <ownId> of comment.id = base64("comment:<postId>_<ownId>")
  fiberPostId: string|null,     // <postId> from that comment.id
  fiberAuthorId: string|null,   // comment.author.id when numeric
  fiberAuthorName: string|null, // comment.author.name
  attachments: [ {type:'image'|'video'|'link', src?:string, href?:string, alt?:string} ]
                                // images: comment-owned <img> not inside [role=button], not inside the avatar/author
                                //   link, and (width||naturalWidth) > 32 → {type:'image', src:img.currentSrc||img.src, alt};
                                // video: <video> → {type:'video', href: closest a?.href||null};
                                // link: comment-owned <a> outside the body whose href host is l.facebook.com
                                //   → {type:'link', href: decoded `u` param}
}
```
`extractRaw` must never click, scroll, or mutate the DOM. Feed-scope posts follow the feed container
rules above (all feeds, role-less fallback).

### 4.2 `collectFeedPosts(opts)` — `src/page/feed.js`
`opts = { markHoverFrom?: number }`. Scans the currently rendered feed post containers (§4 container
rules: every non-dialog `[role="feed"]`, role-less fallback). Never throws. Returns:
```js
{ posts: [ { permalinkHref /* string|null */, postId, idSource, authorName,
             textPreview /*first 160 chars*/, dateText, commentCountText } ],
  missing: [ { hoverId: string } ],   // rendered posts with no id from any source and not hovered yet
                                      // (no header link carries data-fbcs-hover-tried): for each, set
                                      // attribute data-fbcs-hover="<hoverId>" on its best hover candidate
  feedFound: boolean, renderedCount: number,
  groupSlug: string|null,             // decoded /groups/<slug> of location.pathname
  diag: { feeds, rendered, containerMode: 'article'|'children',
          idSources: { link, hover, react, linkAny, comments }, missing, hoverCandidates,
          sampleShapes /* ≤ 3 posts without an id */ } }
```
Post id sources, in order (`idSource`):
1. `'link'`: the feed rule of §4.1 — a header link (outside and before the post body) whose href is
   not lazy and matches `/posts/<id>` or `/permalink/<id>` without comment_id, preferring one whose
   text is a time or date (dates need an English month name, so an author named "Phyo 7" is not a
   date). `permalinkHref` is set only for this source.
2. `'hover'`: a header link carrying `data-fbcs-post-id` (the driver read its href while hovering it;
   Facebook may clear the href again on mouseout).
3. `'react'`: fiber walk (≤ 80 levels, stopping at the feed's fiber) from the container, then its
   first 6 header links: any `memoizedProps` value object (`feedUnit` first) whose string `id`/`__id`
   is base64 of `/^S:_I\d+:VK:(\d+)/`.
4. `'link-any'`: other post-owned, non-lazy, non-comment links outside the body naming one post —
   header links matching `/groups/x/(posts|permalink)/<id>`, `multi_permalinks=`, `story_fbid=`,
   `set=pcb.<id>`, `set=gm.<id>`; links after the body only for `set=pcb.`/`set=gm.` (the post's own
   photos; a shared post's `/posts/` link is never taken). All candidates must agree.
5. `'comments'`: the majority post id of the preview comments, **one vote per comment article**: its
   fiber id (`"comment:<postId>_"`), else its first comment link (`/posts/<id>/?comment_id=`, outside
   the post body — the timestamp, which precedes the comment's text, so links pasted in a comment
   cannot outvote); a comment link outside any comment article votes on its own.
A body/attachment link is never the permalink. Hover candidates (only for posts with no id;
language-independent): header links, lazy ones (`#`/empty/`javascript:`) or ones that are not
profile/user or group-root links; scored aria-labelledby (4) + lazy href (2) + 1–24 chars of text (1);
the best is marked. A post whose header holds a link marked `data-fbcs-hover-tried` (the driver hovered
it already) gets no hoverId — hovering scrolls back to the post, so a post that never yields an id
must not pin the scroll position every round — but still counts in `diag.missing`. hoverIds are `String((opts.markHoverFrom||0) + i)`. `dateText` = the permalink's
text, else the first header link whose text is a time/date. `diag` is privacy-safe: `sampleShapes`
hold container flags (role, aria-label?, aria-labelledby?, aria-posinset?, body?, fiber?) and up to 8
header-link shapes `{where, href, text, ariaLabel, labelledby, tabindex}` — href as a masked shape
(`"#"` kept; path with the group segment → `{g}`, digit runs ≥ 5 → `{n}`, unknown segments → `{s}`;
query KEYS only, `__` tracking keys dropped), text as `len<n>:<classes>` (digit/alpha/other/space/punct).
Never names, text, ids or full URLs. This function may set `data-fbcs-hover` attributes (its only
mutation).

### 4.3 `probePage(opts)` — `src/page/probe.js`
`opts = { expanderPattern, seeMorePattern, sortButtonPattern }` (strings; compile with 'i').
Returns:
```js
{ url, rootKind, loginRequired /* input[name=email] or form[action*="login"] visible and no feed/dialog */,
  blocked /* a visible [role=dialog|alertdialog] with no [role=article], [role=textbox], [contenteditable=true],
             [role=grid] or [role=row] (posts, Messenger chat windows) and ≤ 800 chars of collapsed innerText
             matching /temporarily blocked|can.t use this feature right now|going too fast|try again later|we limit how often/i */,
  postArticleFound, commentCount /* comment articles inside root */,
  expanderCount /* role=button inside root matching expanderPattern */,
  seeMoreCount /* role=button inside root matching seeMorePattern */,
  sortLabel /* text of root role=button[aria-haspopup=menu] matching sortButtonPattern, or null */,
  emptyState, commentCountText,
  feedbackFound /* the open post's "Leave a comment" button exists (comment area rendered), digits or not */,
  loadingCount /* visible [role=progressbar] / [data-visualcompletion=loading-state] inside root */,
  scrollable: { found, scrollTop, scrollHeight, clientHeight }  // root's inner scroll container (dialog) or document.scrollingElement
}
```

### 4.4 Fixtures & browser tests — `tests/fixtures/*.html`, `tests/browser/page-scripts.test.mjs`
Synthetic HTML pages reproducing §1 exactly (roles, aria-labels, hrefs with tracking params,
`dir=auto` structure, emoji `<img alt>`, indentation via `margin-left` so `left` differs per depth),
with a small inline `<script>` emulating behaviour:
- `post-dialog.html`: feed `[role=main]` behind (with one preview comment that must be ignored) +
  `[role=dialog]` with post (author, story_message with "See more" that expands text), comment count
  button "12", sort button "Most relevant" → menu → "All comments" (selecting it reveals 2 hidden
  "spam-ish" top-level comments), 5 top-level comments initially, "View more comments" button
  appending 3 more, lazy-loading 2 more when the inner scroller is scrolled to bottom
  (IntersectionObserver sentinel), "View 2 replies" buttons that append replies after a 300 ms delay
  (one of them revealing a nested "View 1 reply" for a reply-to-reply), one comment truncated with
  "See more", one with a 200×150 image attachment, one with emoji img in author name and body,
  one with "5 reactions; see who reacted to this". Expected totals are documented in a comment at
  the top of the fixture and asserted in the tests.
  Query variants (combinable): `?loadMs=` (loader delay), `?keepLabel=1` (expanders keep their label
  with a spinner beside them while loading), `?duds=N` ("View 1 reply" buttons that load nothing),
  `?dialogDelay=` (dialog mounts late; only the feed is shown before), `?feedbackDelay=` (counts row and
  sort control render late), `?bodyLink=<id>` (the post body links another group post). The dialog's
  Close button removes it and `history.pushState`s back to the group feed (SPA close).
- `post-empty.html`: dialog post with "No comments yet".
- `feed.html`: `[role=feed]` with 30 posts appended in batches of 5 when scrolled near bottom,
  virtualization (posts > 2500px above the viewport get their content emptied), 1 post whose
  permalink href is `#` until `mouseover` of its time link (its body also links another group post
  that must never be taken as its permalink), each post with `aria-label="Leave a comment"`
  count button.
- Markup variants (comma-separated `?variant=`, or `window.FBCS_FIXTURE_VARIANT` which the e2e harness
  injects so canonical post URLs keep the variant): `feed.html` — `nohref` (header links `#`, never
  filled; fake fiber `article['__reactFiber$test'] = {memoizedProps:{}, return:{memoizedProps:
  {feedUnit:{id: btoa('S:_I999:VK:'+postId)}}, return:null}}`), `roleless` (posts are plain divs;
  comment previews keep role=article + aria-label), `twofeeds` (an empty "Featured" feed first),
  `hoverreset` (odd posts' time links get their href only while hovered), `arialabel` (post articles
  also carry an aria-label), and the query param `?noid=<ids>` (with `nohref`: those posts get no fiber
  either — nothing names them); `post-dialog.html` —
  `nohref` (comment timestamp links without href; fiber `{comment:{legacy_fbid, id:
  btoa('comment:'+post+'_'+id), author:{id, name}}}` 2 levels above each comment article),
  `hash` (unfilled links are `href="#"`: the post header's links, and with `nohref` the comment
  timestamp links), `arialabel` (the post articles carry an aria-label), `minus1` (see above), and
  `?commentLinks=<post>_<comment>` (C2 links another post's comment in its body and in a link card
  after it).
Comment ids in `post-dialog.html`: post 1001 uses 2001…/3001…; any other post P prefixes them with
"<digits of P>0" (post 1002: 2001 → 100202001) so a crawl over several posts gets unique ids.
`tests/e2e/extension.test.mjs` [integration] loads `dist/` in Chromium with facebook.com routed to
these fixtures (`/groups/<slug>/` → feed, `/posts/9999/` → empty post, other posts → post-dialog).
Fixtures use the host-relative hrefs `/groups/testgroup/...` (they are served under
`https://www.facebook.com/groups/testgroup/...` in e2e) and must also work via `page.setContent`
in browser tests (use absolute `https://www.facebook.com/...` hrefs to be safe).
Browser tests (Node `playwright` + Chromium, headless) load fixtures, drive them with plain Playwright
(same logic the driver uses), and assert `extractRaw`/`collectFeedPosts`/`probePage` output.
`tests/browser/driver.test.mjs` runs the real `waitForPostRoot`/`preparePost` (pw-driver.js bundled
with esbuild, `playwright-crx` stubbed) against the fixture variants.

### 4.5 `diagnosePage(opts)` — `src/page/diagnose.js`
`opts = { expanderPattern?, seeMorePattern?, sortButtonPattern? }` (defaults built in). Self-contained,
read-only, run in the MAIN world. Returns a privacy-safe structural report of the open page:
`url` (host kind `www`/`web`/…, masked path shape, query keys), `lang`, `dir`, `viewport {w,h,dpr}`,
`visibility`, `rootKind`, `counts` (feeds, feeds in dialogs, dialogs, dialogs with articles, mains,
articles with aria-label / aria-labelledby / aria-posinset, story messages, comment_id links, post
links, lazy links, nodes with a reachable fiber), `feeds` (≤ 4: in dialog?, children, container mode,
containers, rendered, fiber?), `feedPosts` (first ≤ 5 feed containers) and `dialog.post` (the open
post): container attributes present, story_message present, `data-ad-rendering-role` counts, header
and after-body link shapes (as §4.2), fiber reachable / post id found (and depth), comment articles
count with aria-label / permalink / fiber id / fiber author counts; `dialog.controls` and
`page.controls`: role=button counts matching the expander / See more / sort patterns, menu buttons,
and **text shapes** of buttons without aria-label; `page` also lists `<html>`/`<body>` attribute NAMES
and `chrome-extension://` node count (other extensions). Absolutely no names, post/comment text,
numeric ids (digit runs ≥ 5 masked) or full URLs.

---------------------------------------------------------------------------------------------------

## 5. Pure libs — `src/lib/fb-url.js`, `fb-date.js`, `normalize.js`, `diagnostics.js`, `export.js`

### `fb-url.js`
```js
export function parseFbUrl(href, base?) → { host, groupSlug|null, postId|null, commentId|null,
   replyCommentId|null, userId|null, vanity|null }
   // groupSlug from /groups/<slug>/ ; postId from /groups/<slug>/(posts|permalink)/<id> (id: [\w.-]+)
   // or ?multi_permalinks=<id> or ?story_fbid=<id>; commentId from comment_id param; replyCommentId from
   // reply_comment_id; userId from /groups/<slug>/user/<id>/ or /user/<id> or profile.php?id=<id>;
   // vanity from /<name> top-level path (not one of: groups, profile.php, photo, photos, watch, events,
   // hashtag, l.php, story.php, permalink.php, pages, people, reel, share)
export function isFacebookHost(host) → boolean   // facebook.com, www., web., (not m.)
export function canonicalPostUrl(groupSlug, postId) → 'https://www.facebook.com/groups/<slug>/posts/<postId>/'
export function canonicalCommentUrl(groupSlug, postId, commentId, replyCommentId?) → canonicalPostUrl + '?comment_id=<cid>' (+ '&reply_comment_id=<rid>')
export function canonicalProfileUrl({userId, vanity}) → 'https://www.facebook.com/profile.php?id=<id>' | 'https://www.facebook.com/<vanity>' | null
export function stripTracking(href) → same URL without __cft__*, __tn__, ref, notif_*, eid params
export function classifyTabUrl(url) → { kind: 'post'|'group'|'facebook'|'mobile'|'other', groupSlug, postId }
   // 'post' = /groups/<slug>/(posts|permalink)/<id>; 'group' = /groups/<slug> (any subpath except posts/permalink,
   // e.g. '', 'discussion', with or without query); 'mobile' = m.facebook.com / mbasic
export function linkTargetHost(href) → decoded target of l.facebook.com/l.php?u=… or null
```

### `fb-date.js`
```js
export function parseFbDate(text, refMs) → { iso: string|null, approx: boolean }
```
Handles (case-insensitive, optional weekday prefix with/without comma, `at` separator, 24h or
12h `AM/PM`): `"Sunday 4 October 2026 at 18:23"`, `"Sunday, October 4, 2026 at 6:23 PM"`,
`"4 October 2026 at 18:23"`, `"4 October at 18:19"` (no year → year of refMs; if that lands > refMs +
36 h, use previous year), `"October 4 at 6:19 PM"`, `"Yesterday at 10:00"`, `"Today at 9:05 AM"`,
`"4 October 2026"`, `"October 4, 2026"` → exact local time (`approx:false` when time present, `true`
when date only). Relative: `"Just now"`, `"5m"`/`"5 min"`, `"5h"`, `"1d"`, `"1w"`, `"2y"` (FB uses
`m`=minutes), `"5 hours ago"`, `"a day ago"`, `"an hour ago"`, `"2 days ago"`, `"a week ago"`,
`"3 weeks ago"`, `"a month ago"`(30 d), `"2 years ago"`(365 d) → `refMs` minus amount,
`approx:true`. Also accepts an aria-label like `"Comment by X 2 days ago"` — the trailing relative
part is parsed. Unparseable → `{iso:null, approx:true}`. Local-time construction via
`new Date(y, m, d, h, min)`; iso = `toISOString()`.

### `normalize.js`
```js
export function normalizeExtraction(raw, { savedAt, fallbackGroupSlug, mode }) → { posts: PostRecord[], comments: CommentRecord[], warnings: string[] }
```
Per RawPost:
- `postId`, most trustworthy source first: (1)+(2) the post id most items agree on, **one vote per
  item**: its `permalinkHref`'s post id (comment links always carry the real numeric
  `/posts/<postId>/`), else its numeric `fiberPostId` — so one stray link cannot outvote the other
  items' React ids; URL parts come from a link naming the winner, else it is a page-data id;
  (3) `raw.pageUrl` **only** if `raw.rootKind` is `'dialog'|'main'`;
  (4) the post's `permalinkHref` — a link found inside a post can point at another post (a pasted URL,
  a shared post), so it decides only when (1)–(3) give nothing; (5) the post's numeric `fiberPostId`.
  A React id that (3) or (4) confirms uses that URL's parts; otherwise a warning says the id came from
  page data only. A post `permalinkHref` naming another post id is ignored with a warning. No id →
  skip post, add warning `Skipped post #<i> by <author>: no post id found (<n> comments not saved).`
  (author name with whitespace collapsed to one line).
- `groupSlug`: from the same URL source; else `fallbackGroupSlug` (or the page URL's slug) — except
  when the source is a non-group URL (e.g. `permalink.php?story_fbid=…` on the home feed): then only
  the page URL's slug, so a friend's post is never filed under the default group. Without a slug the
  post `url` (and comment permalinks) are the source href without tracking/comment params (`null` for
  an id from React data).
- Comment `id` = `replyCommentId ?? commentId ?? fiberCommentId` (React id only when numeric and the
  item has no permalink); else synthetic
  `'h:' + postId + ':' + djb2(authorName + '|' + text + '|' + (timeAria||timeText))` (hex).
- `threadId` = `commentId` (thread root) or the comment's own id when top-level. A reply without a
  permalink takes the `threadId` of the nearest previous top-level item (DOM is pre-order).
- `isReply` = `!!replyCommentId` || `/^reply by /i.test(ariaLabel)` || (id from React data and the
  item's indentation level > 0 — React data has no thread field; aria wording is English-only).
- `depth`: distinct sorted `left` values among the post's items → index of item's `left`. If all
  `left` equal (or ≤0, e.g. not laid out) → `isReply ? (replyToKind==='reply' ? 2 : 1) : 0`.
  Clamp: top-level (not isReply) depth = 0; replies ≥ 1.
- `replyToName`/`replyToKind`: from ariaLabel: strip leading `"Reply by " + authorName + " to "`
  (if authorName known; else regex `/^Reply by (.+?) to (.+)['’]s (comment|reply)\b/i`), then match
  `/^(.+)['’]s (comment|reply)\b/i` → name, kind. Null when not a reply / unparseable.
- `parentId`: top-level → null. A reply whose aria-label says `to X's reply` (`replyToKind 'reply'`)
  → the nearest previous reply by X in the same thread, searched back only to the reply's branch head
  (the nearest previous same-thread item with a smaller depth, which is checked too) — Facebook caps
  indentation at 2 (§1) and draws in pre-order. Otherwise (or if X's reply isn't in the branch) →
  nearest **previous** item in DOM order with the same `threadId` and `depth === depth-1`; else
  `threadId` (if ≠ own id); else null.
- `createdAt`/`createdAtApprox`: `parseFbDate(timeAria)` if it yields iso; else
  `parseFbDate(timeText || ariaLabel, raw.extractedAt)`. `createdAtText` = `timeAria || timeText`.
- `relativeTime` = `timeText`.
- `reactionCount`: leading number of `reactionLabel` (`"5 reactions…"` → 5, `"1.2K reactions"` → 1200), else 0.
- `authorName` = `authorName || fiberAuthorName || <aria-label parse>`.
- `authorId`/`authorUrl` via `parseFbUrl(authorHref)` + `canonicalProfileUrl`; else numeric
  `fiberAuthorId` (url `profile.php?id=`).
- `permalink` = `canonicalCommentUrl(...)` when ids known else `stripTracking(permalinkHref)`. For an id
  from React data: top-level → `canonicalCommentUrl(slug, postId, id)`; reply →
  `canonicalCommentUrl(slug, postId, threadId, id)` when the thread id is real (not synthetic).
- attachments: hrefs/srcs kept as-is except `stripTracking` on `href`.
- Post: `commentCountExpected` = integer parsed from `commentCountText` (supports "1.2K", "1,234"),
  else null. `postedAt` from `parseFbDate(dateAria || dateText, raw.extractedAt)`.

Records (both stores; all timestamps ISO strings):
```js
PostRecord = { id, groupSlug, url, authorName, authorId, authorUrl, text, postedAt, postedAtApprox, postedAtText,
  commentCountExpected, lastMode /* 'quick'|'post'|'crawl' */, firstSavedAt, lastSavedAt, lastFullScanAt /* null */,
  savedCommentCount /* filled by db */ }
CommentRecord = { id, postId, groupSlug, threadId, parentId, depth, isReply, replyToName, replyToKind,
  authorName, authorId, authorUrl, text, truncated, createdAt, createdAtApprox, createdAtText, relativeTime,
  reactionCount, attachments, permalink, order /* item index */, firstSavedAt, lastSavedAt,
  missingAt /* null */, previousTexts /* [] */ }
```
`normalize` sets `firstSavedAt = lastSavedAt = savedAt`; the db preserves original `firstSavedAt`.

### `diagnostics.js` (pure; no DOM, no chrome.*)
```js
export function maskDigits(s) → s with pfbid… ids replaced by '{pfbid}' and digit runs ≥ 5 by '{n}'
export function urlShape(href) → 'fb:/groups/{g}/posts/{n}/?comment_id' style shape ('ext:' for other hosts)
export function maskLogLine(msg) → "Post i/n: <url> (Author)" → "(author)" and
                                   "Skipped post #i by Author: no post id found (n comments not saved)."
                                   → "by (author): …" — both anchored on the fixed text around the name,
                                   matching any character in it (line breaks, ": "); then URLs →
                                   shapes, then maskDigits
export function buildDiagnosticsReport({ version, userAgent, language, page, pageNote, job, now })
  → { format: 'fb-comment-saver/diagnostics-v1', createdAt, extension, userAgent (masked), language,
      page /* diagnosePage result */, pageNote, lastJob: { mode, status, phase, error, startedAt,
      finishedAt, counters, log /* last 40, masked */ } | null }
```

### `export.js` (pure; no DOM, no chrome.*)
```js
export function buildJson(posts, comments, { exportedAt }) → string
  // { format: EXPORT_FORMAT, exportedAt, postCount, commentCount,
  //   posts: [ { ...post, comments: [ ...comments of post sorted by order ] } ] }  posts sorted by postedAt desc (nulls last), 2-space indent
export function buildCsv(posts, comments) → string
  // '﻿' + header + rows, CRLF, RFC 4180 quoting (quote fields containing , " CR LF; double quotes),
  // one row per comment (posts without comments produce no rows). Free-text columns (post_url,
  // post_author, post_text, reply_to, author_name, author_url, text, created_at_text, attachment_urls,
  // permalink) starting with = + - @ TAB CR get a leading ' (CSV/formula injection; "+1" stays text).
  // Ids, numbers and ISO dates are written as-is (16–17 digit ids: import them as Text in Excel —
  // documented in the README and the export tooltips). Columns, in order:
  // post_id, post_url, post_author, post_posted_at, post_text, comment_id, parent_id, thread_id, depth,
  // is_reply, reply_to, author_name, author_id, author_url, text, created_at, created_at_text,
  // reaction_count, attachment_urls (space-separated), permalink, first_saved_at, last_saved_at, missing_at
export function buildMarkdown(posts, comments, { exportedAt }) → string
  // '# Saved comments' + per post '## <author> — <postedAtText|postedAt>' + url + quoted post text,
  // then threaded comments as nested '- **Author** · date — text' lists in tree pre-order (from
  // buildThreads; 2 spaces per tree level, capped at level 2 like Facebook), multi-line text indented
  // under its bullet; '(not found in last full scan)' suffix when missingAt; a reply whose parent is
  // not stored is listed at level 0 as '- **Author** (reply to X) …'.
export function buildThreads(comments) → [{ c, children }]
  // one post's comments as reply trees: every comment is a node first, then each reply is attached to
  // parentId (else its threadId) wherever that sorts — never "parent must come earlier in order";
  // a reply that would close a cycle, or whose parent is not stored, is a root. Roots and children are
  // sorted by order, then createdAt. Shared by the Markdown export and the library.
export function exportFileName(kind /* 'json'|'csv'|'md' */, scope /* 'all' | postId */, date) → 'fb-comments-<scope>-YYYYMMDD-HHmm.<ext>'
```

---------------------------------------------------------------------------------------------------

## 6. Storage — `src/lib/db.js` (IndexedDB; works in SW, side panel, library page, and Node with fake-indexeddb)

Schema: DB `fb-comment-saver` v1. Stores:
- `posts` keyPath `id`; indexes `lastSavedAt`, `groupSlug`.
- `comments` keyPath `id`; indexes `postId`, `lastSavedAt`, `authorName`.

```js
export function openDb(): Promise<IDBDatabase>              // cached per realm; uses globalThis.indexedDB
export async function savePostBundle(post, comments, { fullScan, now, maxMissingRatio? }) → { inserted, updated, unchanged, markedMissing, total
                                                            //   [, fullScanDowngraded, wouldMarkMissing] }
export async function listPosts() → PostRecord[]            // sorted lastSavedAt desc
export async function getPost(id) → PostRecord|undefined
export async function getComments(postId) → CommentRecord[] // sorted by order asc (then createdAt)
export async function getAllComments() → CommentRecord[]
export async function searchComments(query, { limit = 500 }) → CommentRecord[]  // case-insensitive in text/authorName
export async function getStats() → { posts, comments, lastSavedAt|null }
export async function deletePost(id) → void                 // also deletes its comments
export async function clearAll() → void
export async function postsScannedSince(ms) → Set<string>   // ids with lastFullScanAt >= ms
```
`savePostBundle` merge semantics (single readwrite transaction over both stores):
- Post exists → keep `firstSavedAt`; for each incoming field, overwrite only if the incoming value is
  non-null/non-empty (except `lastSavedAt`, `lastMode`); `lastFullScanAt = now` when `fullScan`.
- Comment exists → keep `firstSavedAt`, `previousTexts`; if incoming `text` differs from stored and
  incoming is non-empty: if `incoming.truncated` and stored text starts with incoming text (minus a
  trailing "…"/"..." and whitespace) → keep stored text; else push `{text: stored.text, savedAt: stored.lastSavedAt}`
  onto `previousTexts` and take the new text. Other fields: incoming non-null wins. `missingAt = null`.
  Count as `updated` if any field other than `lastSavedAt` changed, else `unchanged`.
  Exception — `order`: when the save is not a `fullScan` and the stored post already has a
  `lastFullScanAt`, the stored `order` is kept (a partial save numbers only the comments that were
  visible, which would sort replies under the wrong parent). Before any full scan, the latest save wins.
- New comment → `inserted`. When stored orders are kept (previous rule), a comment new to the post
  does not keep its partial-save index: each run of new comments is placed (fractional orders) right
  after the stored comment that precedes it in that save's DOM order and strictly before the next
  stored order; a run before any stored comment goes right before the first stored one that follows.
- When a save renumbers (full scan, or any save before the first full scan), stored comments of the
  post that it did not see keep their place: they get orders right after the comment that preceded
  them before (in its new numbering), instead of a stale index that would tie with others.
- If `fullScan`: every stored comment of that post whose id is not in the incoming set and whose
  `missingAt` is null → `missingAt = now` (`markedMissing++`). (Never delete.)
- Optional `maxMissingRatio` (the job runner passes 0.25): a full scan that would newly mark ≥ 3
  comments missing **and** more than that share of the post's stored non-missing comments is saved as
  a partial save (no missing marks, no `lastFullScanAt`, orders kept as for a partial save); the result
  then also has `fullScanDowngraded: true` and `wouldMarkMissing` (both present whenever the option is
  given).
- Finally set post `savedCommentCount` = number of stored comments for that post.
`now` defaults to `new Date().toISOString()`; the job runner passes the same `savedAt` it gave to
`normalizeExtraction`. Result `total` = stored comments of the post after the save
(= `savedCommentCount`); comments in this save = `inserted + updated + unchanged`.

---------------------------------------------------------------------------------------------------

## 7. Background — `src/background/*`

### `service-worker.js` (entry)
- On install/startup: `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`.
- Message router (`chrome.runtime.onMessage`, return `true` for async `sendResponse`):
  `START_JOB` → `jobRunner.start(mode, tabId, overrides)` → `{ok:true}` or `{ok:false, error}`
  (error if a job is already running); `STOP_JOB` → `jobRunner.stop()`; `GET_JOB` → current JobState.
- On startup, if a persisted JobState has `status:'running'` (SW was killed), rewrite it as
  `status:'interrupted'` with a log line.

### `job-runner.js`
```js
export function start(mode, tabId, overrides) → Promise<void>   // rejects if running; runs job async (not awaited by router)
export function stop() → void        // sets AbortController; job ends with status 'stopped'
export function getState() → JobState
JobState = { id, mode, status: 'idle'|'running'|'stopping'|'done'|'stopped'|'error'|'interrupted',
  tabId, startedAt, finishedAt|null, phase /* human-readable current step */,
  postsTotal, postsDone /* processed: saved or failed */, postsFailed, commentsSeen, inserted, updated, markedMissing,
  currentPostUrl|null, error|null, log: [{t /*ISO*/, level:'info'|'warn'|'error', msg}] /* last 300 */ }
```
- State persisted to `chrome.storage.session[JOB_STATE_KEY]` (throttled ≤ 4 writes/s, always on
  status change and at end). UIs observe via `chrome.storage.onChanged`.
- After each saved post: `chrome.runtime.sendMessage({type: MSG.DB_CHANGED, postIds})` (catch "no
  receiver" errors).
- Keep-alive while running: call `chrome.runtime.getPlatformInfo()` every 20 s.
- Modes:
  - `quick`: `chrome.scripting.executeScript({target:{tabId}, func: extractRaw, args:[{scope:'auto'}],
    world: 'MAIN'})` (MAIN world so React data is visible, §1) → `normalizeExtraction` →
    `savePostBundle(..., {fullScan:false})` for each post. No debugger.
    `fallbackGroupSlug` is the tab's (or the settings') group only on `group`/`post` tabs; else null.
  - `post`: tab URL must classify as `post` (else error "Open a post first"). Uses `pw-driver`:
    attach → `waitForPostRoot` → `processOpenPost` (expected post id = the tab URL's).
  - `crawl`: attach; unless `isGroupFeedUrl(tabUrl, settings)` (exactly the feed in the chosen sort —
    another group page such as /members, a member's posts, or another sort does not count) →
    `page.goto(buildGroupFeedUrl(settings))`; `collectFeedLinks` until `maxPosts`; drop posts
    with `lastFullScanAt` within `skipSavedWithinHours` (if > 0); for each: log
    `"Post i/n: <url> (<author>)"` (author whitespace collapsed to one line), `page.goto(url)` →
    `waitForPostRoot` → `processOpenPost` (expected id = the link's); per-post errors are logged,
    counted in `postsFailed`, and the crawl continues; abort entire crawl on `blocked` or
    `loginRequired`. At the end, if `returnToGroupAfterCrawl`, `page.goto(groupFeedUrl)`.
  - `processOpenPost`: `preparePost` → `page.evaluate(extractRaw, {scope:'auto'})`. Unless the
    extraction has `rootKind` `'dialog'|'main'` and exactly one post, throw (the post was closed or the
    tab navigated: nothing is saved — never the page behind). `fullScan = result.complete`, downgraded
    to false (with a warning) when `raw.rootKind !== result.rootKind`, or when the normalized post id is
    not the expected one (a non-numeric expected id, e.g. pfbid, also matches while the page URL still
    names it). Saves pass `maxMissingRatio: 0.25` with a full scan and log a warning when the db
    downgraded it (§6).
  - Always: detach Playwright in `finally` (releases chrome.debugger, removes the infobar).

### `pw-driver.js` (all Playwright usage lives here)
```js
import { crx } from 'playwright-crx';
export async function withPage(tabId, fn /* (page) => Promise<T> */, { onDetach(reason) }?) → T
    // crxApp = await crx.start() (reuse via crx.get() if already started); page = await crxApp.attach(tabId);
    // try { return await fn(page) } finally { await crxApp.detach(page).catch(); await crxApp.close().catch(); }
    // onDetach: chrome.debugger.onDetach for this tab while fn runs (e.g. 'canceled_by_user')
export async function waitForPostRoot(page, { timeoutMs, signal? }) → 'dialog'|'main'   // waits for a dialog/main post article; throws on timeout
    // A [role=main] holding a feed is never accepted (§1: a fresh post URL shows the home feed until the
    // dialog mounts); a visible dialog skeleton (progressbar / "<name>'s post" title) means "loading".
    // A single-post main is accepted at once when it links to the URL's post id, else after 5 s
    // without a dialog.
export async function preparePost(page, ctx) → { complete: boolean, rounds, clicks, rootKind, reason, commentCount }
    // throws POST_CLOSED_MSG when the post goes away mid-expansion (see below)
export async function collectFeedLinks(page, ctx) → [{ postId, url, authorName, textPreview, dateText, commentCountText }]
// ctx = { settings, patterns /* compilePatterns(settings) */, signal /* AbortSignal */, log(level,msg), progress(partialState) }
```
`preparePost` algorithm (respect `signal` between every step; `sleep` = `actionDelayMs` + jitter):
1. `probePage` → abort with error if `loginRequired`/`blocked`. `root` locator =
   `page.locator('[role="dialog"]:has(<ROOT_POST_SEL>)').last()` for dialog, else
   `page.locator('[role="main"]:has(<ROOT_POST_SEL>)').first()` (post articles with or without
   aria-label, §4). The root must stay on the page: it is checked (`root.count()`)
   at the start of every round, before the expanders and before returning; gone → throw
   `POST_CLOSED_MSG`. So does a later probe whose `rootKind` differs (dialog closed → feed/none), and
   a comment count that drops to 0 after having been > 0. If the root changes from `'main'` to
   `'dialog'` (the dialog mounted late), the root is rebuilt, the round state reset and steps 2–3 redone.
2. If `expandSeeMore`: click post-level "See more" (role=button matching seeMorePattern, not inside a
   comment article).
3. Sort. The comment area can render after the post body: if there is no sort control yet, wait
   (≤ 5 s) until `feedbackFound` or `emptyState`, then (≤ 5 s more) for the sort control when the
   count has digits. If `sortAllComments` and the sort text doesn't match `sortAllItemPattern`:
   click it, then the "All comments" `menuitem` → click; wait for the button text to change
   (≤ 5 s); log result. Missing sort control (0 comments) is fine. At most 2 switch attempts per post.
4. Loop rounds (≤ `maxExpandRounds`, and ≤ `postTimeoutSec` total):
   a. scroll: hover the root's center, `page.mouse.wheel(0, 2500)` ×2, then `scrollIntoViewIfNeeded`
      the last comment article in root (if any); `sleep` (twice in quiet rounds while fewer comments
      are loaded than Facebook's count − 1).
   b. expanders = `root.getByRole('button', { name: patterns.expander })` (if `!expandReplies`, only
      ones whose text does not match /repl/i). Click them one at a time in DOM order using
      `clickRobust` (Playwright `click({timeout: 4000})` → fallback `dispatchEvent('click')` →
      fallback `evaluate(el => el.click())`); after each click `sleep`, then wait (≤ 10 s) until no
      loading indicator (`[role=progressbar]`, `[data-visualcompletion=loading-state]`, visible and
      near the viewport) is left in root. Attempts are counted **per thread**: key = label + id of the
      comment just before the button in document order. A click is unproductive when, after loading
      settled, the count did not grow and the button is still there with the same text (still loading
      → judged next round); 3 unproductive clicks → that button is "stuck" and skipped.
      A loading indicator visible for 15 s in a row is ignored from then on (logged).
   c. if `expandSeeMore`: click every comment-owned "See more".
   d. wait (≤ 10 s) for loading indicators to clear, then measure (probePage, `commentCount`). If the
      sort shows something other than "All comments" (`sortAllComments`), switch again (within the
      2 attempts). A round is quiet when the count did not grow, nothing is loading, the sort was not
      just switched, and (dialog) the scroller is at the bottom or did not move since the last round.
      Done when a round clicked no expanders, the last 2 rounds were quiet (3 while fewer comments are
      loaded than Facebook's count − 1), and no "See more" remain → `complete:true`.
   Hitting max rounds/timeout → `complete:false` with `reason`. Also incomplete: stuck expanders,
   replies not expanded, still loading, the final sort label not "All comments" (when it is shown),
   or a comment count lower than an earlier round's.
5. Close any `[role="menu"]` left open (Escape).

`collectFeedLinks` algorithm: wait for the feed (`pageFeedReady`: a `[role=feed]` with an article
or a child with text); move mouse to viewport center; loop: `page.evaluate(collectFeedPosts,
{markHoverFrom})` → add to ordered Map by postId; for up to 10 `missing` hoverIds per round:
`page.hover('[data-fbcs-hover="<id>"]')`, then **immediately** `page.evaluate(hoveredPostLink, id)`
(self-contained: marks the link `data-fbcs-hover-tried`, reads its href, parses
`/posts|permalink/<id>`, `multi_permalinks=`, `story_fbid=`; on success sets `data-fbcs-post-id` on the
link so later scans know it — Facebook can clear the href on mouseout), once more after 200 ms if
empty; a failed hover marks the link tried too (`markHoverTried`), so each post is hovered at most
once; then re-collect once and move the mouse back; `page.mouse.wheel(0, 1600)`; `sleep`; stop when map size ≥ `maxPosts` or 6 consecutive rounds
without growth, or signal aborted. Return first `maxPosts`, URLs canonicalized via
`canonicalPostUrl(slug, postId)` with slug = the link's own slug, else the scan's `groupSlug` (the feed
page's group), else the settings' group (keeping the tab's host, e.g. web.facebook.com, is NOT needed
— always www). Diagnostics aggregated over rounds; always logs one summary line
`"Feed scan: N posts seen — ids from links L, page data R, comment links C, hover H; M without an id."`
(M = the largest number of posts without an id in one round's last scan; N = found + M)
and, when no id was found, a warning with the masked scan details (feeds, rendered, containerMode,
hoverCandidates, sampleShapes) and the hint "Click 'Copy diagnostics' in the side panel and send the
report."

---------------------------------------------------------------------------------------------------

## 8. UI — `src/ui/*`

Design: compact, clean, system font stack, CSS variables in `common.css` with light/dark via
`prefers-color-scheme`; Myanmar text must render (font stack includes "Noto Sans Myanmar",
"Myanmar Text", "Padauk", sans-serif). No external resources (MV3 CSP): no CDN fonts/scripts.

`common.js` exports: `downloadText(filename, text, mime)` (Blob + object URL + temporary `<a download>`),
`formatDate(iso)` (locale short date-time; '—' for null), `relTime(iso)`, `el(tag, attrs, ...children)`
(tiny DOM builder; sets textContent for strings — never innerHTML with data), `debounce(fn, ms)`.

### Side panel (`sidepanel.html/.css/.js`)
- Header: title "FB Comment Saver" + small status chip for the active tab **of the panel's own
  window** (each window has its own side panel): Post / Group feed / Facebook (other page) /
  Not Facebook / Mobile site (unsupported) — window id from `chrome.windows.getCurrent()` at init, then
  `chrome.tabs.query({active:true, windowId})` + `classifyTabUrl`, refreshed on
  `chrome.tabs.onActivated` (events of that window only) / `onUpdated` (that tab). Focus changes to
  other windows are ignored. Right before **starting a job** or **Open group**, the panel re-queries
  its window's active tab; if it is not the tab shown (id or kind changed), it refreshes and shows a
  toast instead of acting.
- Card "This post": buttons **Save all comments** (mode `post`; disabled unless tab kind is `post`)
  and **Quick save (visible only)** (mode `quick`; enabled on any Facebook tab). Short hint text.
- Card "Group crawl": group URL (from settings, editable), feed sort select, max posts number,
  "skip posts scanned within N hours" number, **Start crawl** (mode `crawl`; enabled on any
  `www/web.facebook.com` tab) and **Open group** link button (opens/navigates active tab to the group).
- Card "Progress" (visible when a job exists): status badge, phase, progress bar
  (postsDone/postsTotal), counters (comments seen / new / updated / missing / failed posts),
  **Stop** button while running, scrollable log (latest at bottom, auto-scroll), and a note
  "Keep this tab visible while saving — Facebook only loads comments in a visible tab."
- Card "Archive": stats (posts / comments / last saved), **Open library** (opens `library.html` in a
  new tab), **Export JSON**, **Export CSV**, **Export Markdown** (all data, via db + export.js +
  downloadText).
- Collapsible "Settings": sortAllComments, expandReplies, expandSeeMore (checkboxes),
  actionDelayMs, maxExpandRounds, postTimeoutSec, returnToGroupAfterCrawl, advanced patterns
  (text inputs; validate regex on blur; show error inline), **Reset to defaults**. Saved via
  `saveSettings` on change (debounced).
- **Copy diagnostics**: a button in the Progress card's footer (next to Dismiss) shown when a job ended
  with an error/interruption or saved no post (`postsDone − postsFailed ≤ 0`), and always in the
  Settings section ("Troubleshooting"). It runs `diagnosePage` on the panel's tab via
  `chrome.scripting.executeScript({world:'MAIN'})` when that tab is a www/web.facebook.com page (else
  only a `pageNote`), builds `buildDiagnosticsReport({version: chrome.runtime.getManifest().version,
  userAgent, language, page, pageNote, job})` and copies the 2-space JSON with
  `navigator.clipboard.writeText` → toast "Diagnostics copied — paste it in your message". If the
  clipboard refuses, the JSON is shown in a read-only textarea under the button with "Select all" and
  "Close" (built with `el()`/textContent, no innerHTML).
- Live updates: `chrome.storage.onChanged` (session `jobState`) + `MSG.DB_CHANGED` → refresh stats.
- Explain the yellow "started debugging this browser" bar in a one-line hint under the buttons.

### Library (`library.html/.css/.js`)
- Top bar: title, search input (debounced 250 ms, searches comment text & author across all posts),
  stats, export buttons (All: JSON/CSV/MD), "Clear all" (double confirm via `confirm()`).
- Left column: post list (author, posted date, text preview 2 lines, saved/expected comment
  counts, last saved, badge if last scan incomplete i.e. `lastFullScanAt` null). Filter box
  filters posts by text/author. Click selects.
- Right column: selected post header (author, date, full text with line breaks preserved, link
  "Open on Facebook" `target=_blank rel=noopener`), per-post export (JSON/CSV/MD), "Delete post"
  (confirm). Threaded comments: trees from `buildThreads` (export.js: parentId, else threadId; a reply
  is nested under its parent even when its `order` sorts first); nesting is capped at 2 levels like
  Facebook — below level 2 the rest of a branch is listed flat in pre-order, each reply labelled
  "replying to X" (CSS safety net: a third nested `.thread-replies` has no indent); a reply whose parent
  is not stored is a root indented by its `depth`. Per comment: author (link to profile when available),
  date (`createdAt` formatted, `createdAtText` in title attr), reactions count, text with line breaks
  (`white-space: pre-wrap`), attachments as links (images as small thumbnails `<img loading=lazy
  referrerpolicy=no-referrer>` — fbcdn URLs may expire), "edited" marker with previous versions in a
  `<details>`, "not found in last full scan" marker for `missingAt`, "Open" permalink link.
- Search results mode: flat list of matching comments with post context; click → select post and
  scroll to/highlight the comment (`id="c-<commentId>"`).
- Deep links: `library.html#post=<id>[&comment=<cid>]`. `openLibrary(postId)` (common.js) adds a nonce
  `&t=<ms>` so that re-opening the same post in an open library still fires `hashchange` (e.g. to
  leave search results); the library ignores unknown params and rewrites the hash to `#post=<id>`.
- CSV export buttons' tooltips say to import the id columns as Text in spreadsheets.
- Auto refresh on `MSG.DB_CHANGED`.
- All dynamic text via `textContent` (no innerHTML with user data — XSS safety).

---------------------------------------------------------------------------------------------------

## 9. Manifest (`src/manifest.json`; build injects `version` from package.json)
```json
{
  "manifest_version": 3,
  "name": "FB Group Comment Saver",
  "description": "Save comments and replies from Facebook group posts to a local archive. Uses Playwright (playwright-crx) to expand every comment.",
  "minimum_chrome_version": "118",
  "permissions": ["debugger", "sidePanel", "storage", "unlimitedStorage", "scripting", "tabs"],
  "host_permissions": ["https://www.facebook.com/*", "https://web.facebook.com/*", "https://facebook.com/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "FB Comment Saver", "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png" } },
  "icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```
Icons are generated by `build.mjs` (pure Node: zlib + hand-written PNG encoder; a rounded blue
square with a white speech bubble + down-arrow "save" glyph), no image deps.

## 10. Non-goals / constraints
- No network calls of our own; all data stays local (IndexedDB). No analytics.
- Never post, react, or type into Facebook. Only clicks on: sort button, sort menu item
  "All comments", expanders, "See more". Never click "Hide", "Reply", "Like", "Share", menus.
- Crawling is paced (`actionDelayMs` + jitter) and bounded (`maxPosts`); stops on block/login walls.
