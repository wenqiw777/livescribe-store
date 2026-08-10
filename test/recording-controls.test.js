#!/usr/bin/env node
// Recording lifecycle regression:
//  * every meeting asks for consent, even when an old "always" preference exists;
//  * the user can end recording without ending the Zoom meeting;
//  * restored sessions recover duration from caption timestamps when metadata is bad.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function newPage({ sessions = [] } = {}) {
  const saved = [];
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only', url: 'https://app.zoom.us/wc/123/start', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; },
  });
  w.chrome = {
    storage: {
      // Simulate a user who previously selected the old "Yes, always" option.
      sync: { get: (_keys, cb) => cb({ autoStart: true, autoCaptions: true }), set() {} },
    },
    runtime: {
      lastError: null,
      connect: () => ({ postMessage() {} }),
      sendMessage(msg, cb) {
        if (msg.type === 'SAVE_SESSION') saved.push(msg.session);
        const res = msg.type === 'GET_SESSIONS' ? { sessions } : { ok: true };
        if (cb) w.setTimeout(() => cb(res), 0);
      },
    },
  };
  w.navigator.clipboard = { writeText: async () => {} };
  w.eval(fs.readFileSync(path.join(SRC, 'collector.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'));
  return { w, saved };
}

(async () => {
  // Every meeting must ask, regardless of stale autoStart storage.
  const live = newPage();
  live.w.LSPanel.mount('Zoom');
  await sleep(20);
  const consent = live.w.document.querySelector('.ls-consent');
  const consentButtons = consent ? [...consent.querySelectorAll('button')].map(b => b.textContent) : [];
  const askedFirst = !!consent && !live.w.LSPanel.isStarted();
  const noAlways = !consentButtons.some(x => /always/i.test(x));

  // Explicit consent starts recording, and the user can stop it independently.
  const yes = consent && [...consent.querySelectorAll('button')].find(b => /this time/i.test(b.textContent));
  if (yes) yes.click();
  live.w.LSCollector.update('a', 'Alex Johnson', 'We will launch Friday');
  live.w.LSCollector.finalize('a');
  const endButton = live.w.document.querySelector('[data-act="end"]');
  const liveExportButton = live.w.document.querySelector('[data-act="export"]');
  if (endButton) endButton.click();
  await sleep(30);
  const endedTitle = live.w.document.querySelector('.ls-export strong')?.textContent || '';
  const stopped = !live.w.LSCollector.isRecording();
  const savedEnded = live.saved.some(s => s && s.ended === true);

  // A legacy/broken session has endedAt ~= startedAt, but its last caption was
  // at 08:50. Both visible duration locations should recover to 08:50.
  const brokenStart = Date.now() - 530000;
  const broken = {
    id: 'ls_old', platform: 'Zoom', title: 'Old meeting', startedAt: brokenStart, endedAt: brokenStart + 1,
    ended: true, handled: false, transcript: 'Sarah: final line', highlights: [],
    lines: [{ speaker: 'Sarah', text: 'final line', t: 530000 }],
  };
  const restored = newPage({ sessions: [broken] });
  restored.w.LSPanel.resumePending('Zoom');
  await sleep(50);
  const subtitle = restored.w.document.querySelector('.ls-export .ls-sub')?.textContent || '';
  const headerTime = restored.w.document.querySelector('.ls-time')?.textContent || '';

  const checks = [
    ['meeting asks before recording', askedFirst],
    ['old Yes always option removed', noAlways],
    ['End recording button exists', !!endButton],
    ['live Export button removed', !liveExportButton],
    ['End recording stops collector', stopped],
    ['manual end saves ended session', savedEnded],
    ['manual end has correct title', /Recording ended/.test(endedTitle)],
    ['broken metadata recovers subtitle', /08:50/.test(subtitle)],
    ['restored header shows duration', headerTime === '08:50'],
  ];
  for (const [name, ok] of checks) console.log(name.padEnd(40), ok ? 'PASS' : 'FAIL');
  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
