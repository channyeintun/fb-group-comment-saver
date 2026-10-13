// Extension service worker (entry, bundled to dist/background.js). See SPEC.md §7.

import { MSG } from '../lib/constants.js';
import * as jobRunner from './job-runner.js';

/** Clicking the toolbar icon opens the side panel. */
function enableSidePanelOnActionClick() {
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[sw] setPanelBehavior failed:', err));
}

chrome.runtime.onInstalled.addListener(enableSidePanelOnActionClick);
chrome.runtime.onStartup.addListener(enableSidePanelOnActionClick);

// Every service-worker start: load the persisted job state; a job still marked 'running' died
// with the previous worker and is rewritten as 'interrupted'.
jobRunner.init();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own pages talk to the worker (no content scripts, no externally_connectable).
  if (sender?.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case MSG.START_JOB:
      jobRunner
        .start(msg.mode, msg.tabId, msg.overrides)
        .then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
        );
      return true; // async sendResponse

    case MSG.STOP_JOB:
      jobRunner.stop();
      sendResponse({ ok: true });
      return false;

    case MSG.GET_JOB:
      jobRunner.init().then(
        () => sendResponse(jobRunner.getState()),
        () => sendResponse(jobRunner.getState()),
      );
      return true;

    default:
      return false; // e.g. DB_CHANGED broadcasts between pages
  }
});
