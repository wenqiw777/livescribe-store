// Regression test: a Zoom meeting ends, the tab navigates to a post-meeting
// page, and the transcript must NOT vanish.
//
// What went wrong live: the transcript lived only in the page's memory. Ending
// a Zoom call navigates the tab, which destroys the content script and with it
// every captured line; the 2-second "did we leave the meeting" poll never got a
// chance to run, so no prompt appeared either. With "Yes, always" remembered,
// the fresh page then started a brand-new session — so it looked like the
// transcript had been wiped and recording restarted.
//
// The fix is persist-then-resume: the session is written to extension storage,
// and the next page load raises the export prompt for any session that ended
// without being handled.
//
// Run: npm i jsdom && node test/resume-export.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');

// --- a stand-in for the extension's storage + messaging -------------------
const store = { sessions: [] };
function makeChrome(win) {
  return {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        let res = { ok: true };
        if (msg.type === 'SAVE_SESSION') {
          const i = store.sessions.findIndex(s => s.id === msg.session.id);
          if (i >= 0) store.sessions[i] = { ...store.sessions[i], ...msg.session };
          else store.sessions.unshift(msg.session);
        } else if (msg.type === 'GET_SESSIONS') {
          res = { sessions: store.sessions };
        }
        if (cb) win.setTimeout(() => cb(res), 0);
      },
    },
    storage: {
      sync: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
      local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
    },
  };
}

function newPage() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only', url: 'https://app.zoom.us/wc/123/start', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; },
  });
  window.chrome = makeChrome(window);
  window.eval(fs.readFileSync(path.join(SRC, 'collector.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'));
  return window;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- page 1: the meeting ----------
  const p1 = newPage();
  p1.LSPanel.mount('Zoom');
  // user consents
  p1.document.querySelectorAll('#ls-panel .ls-consent .ls-btn')[0].click();

  p1.LSCollector.update('a', 'Alex Johnson', 'we ship onboarding on Friday');
  p1.LSCollector.update('b', 'Chris Lee', 'I will run QA on Thursday');
  await sleep(50);

  // The meeting ends while captions are still active. meetingEnded() itself
  // must stop the collector and commit the final words before it snapshots.
  p1.LSPanel.meetingEnded();
  await sleep(80);

  const savedAfterEnd = store.sessions[0];
  const promptOnMeetingPage = !!p1.document.querySelector('#ls-panel .ls-export');

  // ---------- page 2: Zoom navigates the tab away ----------
  // Everything in page 1 is gone: new context, empty collector.
  const p2 = newPage();
  const freshLines = p2.LSCollector.lineCount();
  p2.LSPanel.resumePending('Zoom');
  await sleep(120);

  const box = p2.document.querySelector('#ls-panel .ls-export');
  const heading = box && box.querySelector('strong') && box.querySelector('strong').textContent;
  const buttons = box ? [...box.querySelectorAll('.ls-btn')].map(b => b.textContent) : [];

  console.log('saved on end            :', savedAfterEnd ? `${savedAfterEnd.lines.length} lines, ended=${savedAfterEnd.ended}` : 'NOTHING');
  console.log('prompt on meeting page  :', promptOnMeetingPage);
  console.log('new page collector lines:', freshLines, '(context really was destroyed)');
  console.log('prompt after navigation :', heading || '(none)');
  console.log('buttons offered         :', JSON.stringify(buttons));

  const persisted = !!savedAfterEnd && savedAfterEnd.lines.length === 2 && savedAfterEnd.ended === true;
  const survived = !!box;
  const asksSummary = buttons.some(b => /summarize/i.test(b));
  const offersMd = buttons.some(b => /\.md/i.test(b));
  const offersTxt = buttons.some(b => /\.txt/i.test(b));

  // Dismissing must stop it nagging on every later page load.
  const notNow = box && [...box.querySelectorAll('.ls-btn')].find(b => /not now/i.test(b.textContent));
  if (notNow) notNow.click();
  await sleep(60);
  const p3 = newPage();
  p3.LSPanel.resumePending('Zoom');
  await sleep(120);
  const nagsAgain = !!p3.document.querySelector('#ls-panel .ls-export');

  console.log('---');
  console.log('transcript persisted      :', persisted ? 'PASS' : 'FAIL');
  console.log('prompt survives navigation:', survived ? 'PASS' : 'FAIL');
  console.log('offers Summarize          :', asksSummary ? 'PASS' : 'FAIL');
  console.log('offers .md                :', offersMd ? 'PASS' : 'FAIL');
  console.log('offers .txt               :', offersTxt ? 'PASS' : 'FAIL');
  console.log('dismiss stops re-prompting:', !nagsAgain ? 'PASS' : 'FAIL');

  const ok = persisted && survived && asksSummary && offersMd && offersTxt && !nagsAgain;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
