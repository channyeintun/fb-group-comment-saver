// Shared constants. See SPEC.md §3.

export const DB_NAME = 'fb-comment-saver';
export const DB_VERSION = 1;
export const EXPORT_FORMAT = 'fb-comment-saver/v1';
export const DEFAULT_GROUP_URL = 'https://www.facebook.com/groups/myanmarsoftwareengineers';

export const MSG = {
  START_JOB: 'START_JOB', // UI → SW  {type, mode:'quick'|'post'|'crawl', tabId:number, overrides?:Partial<Settings>}
  STOP_JOB: 'STOP_JOB', // UI → SW  {type}
  GET_JOB: 'GET_JOB', // UI → SW  {type} → JobState
  DB_CHANGED: 'DB_CHANGED', // SW → all {type, postIds:string[]}
};

export const JOB_STATE_KEY = 'jobState'; // chrome.storage.session key
export const SETTINGS_KEY = 'settings'; // chrome.storage.local key

/**
 * @typedef {typeof DEFAULT_SETTINGS} Settings
 */
export const DEFAULT_SETTINGS = {
  groupUrl: DEFAULT_GROUP_URL,
  feedSort: 'CHRONOLOGICAL', // 'CHRONOLOGICAL' | 'RECENT_ACTIVITY' | 'TOP_POSTS' | 'DEFAULT' → ?sorting_setting=
  maxPosts: 20, // crawl: number of posts to collect from the feed
  skipSavedWithinHours: 0, // crawl: skip posts fully scanned within N hours (0 = never skip)
  sortAllComments: true, // switch "Most relevant" → "All comments"
  expandReplies: true, // click "View N replies"
  expandSeeMore: true, // click "See more" in post/comment bodies
  actionDelayMs: 700, // base delay between UI actions (+ random 0..50% jitter)
  maxExpandRounds: 40, // per post
  postTimeoutSec: 240, // per post hard cap for expansion
  returnToGroupAfterCrawl: true,
  expanderPattern:
    '^(view|see)( all| more| previous)?( \\d[\\d,.]*[km]?)?( more| previous)? (comments?|repl(y|ies)|answers?)\\b|^\\d[\\d,.]*[km]? (more )?repl(y|ies)$',
  seeMorePattern: '^see more$',
  sortButtonPattern: '^(most relevant|newest|all comments|top comments|most recent|oldest)$',
  sortAllItemPattern: '^all comments',
};
