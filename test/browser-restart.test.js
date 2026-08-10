// Browser-close test: the whole browser is shut down mid-meeting, then reopened.
//
// The data side is fine on its own — chrome.storage.local outlives a restart.
// The problem is DISCOVERY: the in-meeting prompt can never come back, because
// the meeting tab no longer exists, and the user has no reason to revisit that
// URL. So the transcript would sit in storage forever, unseen.
//
// After a restart the toolbar badge must show the count, and opening the popup
// must offer the same three choices the in-meeting prompt did.
//
// Run: npm i jsdom && node test/browser-restart.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// One "disk" that survives across simulated browser sessions.
const disk = {};
const badge = { text: '', title: '' };

function chromeApi() {
  return {
    action: {
      setBadgeText: async o => { badge.text = o.text; },
      setBadgeBackgroundColor: async () => {},
      setTitle: async o => { badge.title = o.title; },
    },
    runtime: {
      lastError: null,
      onStartup: { addListener: fn => { chromeApi._startup = fn; } },
      onConnect: { addListener: () => {} },   // meeting-tab port; unused here
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: fn => { chromeApi._msg = fn; } },
      openOptionsPage: () => {},
    },
    storage: {
      local: {
        get: async (k) => {
          if (k === null || k === undefined) return { ...disk };
          if (typeof k === 'string') return { [k]: disk[k] };
          return Object.fromEntries(Object.keys(k).map(x => [x, disk[x]]));
        },
        set: async (o) => { Object.assign(disk, o); },
        remove: async (keys) => { (Array.isArray(keys) ? keys : [keys]).forEach(k => delete disk[k]); },
      },
      sync: { get: async () => ({}), set: async () => {} },
    },
  };
}

// --- boot the service worker (fresh, as on browser start) ------------------
function bootWorker() {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = chromeApi();
  w.fetch = async () => ({ ok: false, status: 0, json: async () => ({}) });
  w.eval(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'));
  return w;
}

const call = (w, msg) => new Promise(res => {
  w.chrome.runtime.lastError = null;
  chromeApi._msg(msg, {}, res);
});

(async () => {
  // ---------- browser session 1: a meeting happens ----------
  let w = bootWorker();
  const sid = 'ls_1000';
  await call(w, { type: 'SAVE_SESSION', session: { id: sid, platform: 'Zoom', title: 'Weekly sync', startedAt: 1000, endedAt: 2000 } });
  await call(w, { type: 'APPEND_LINES', sessionId: sid, from: 0, lines: [
    { speaker: 'Alex Johnson', text: 'we ship onboarding on Friday', t: 4000 },
    { speaker: 'Chris Lee', text: 'I will run QA on Thursday', t: 9000 },
  ] });
  await call(w, { type: 'SET_PENDING', sessionId: sid, line: { speaker: 'Prisha', text: 'and the pricing page' } });

  // ---------- the browser is closed. Nothing is flushed, nothing is cleaned up.
  const keysOnDisk = Object.keys(disk).length;

  // ---------- browser session 2: fresh worker, same disk ----------
  w = bootWorker();
  if (chromeApi._startup) await chromeApi._startup();      // onStartup fires
  await new Promise(r => setTimeout(r, 30));

  const { sessions: pending } = await call(w, { type: 'PENDING' });
  const restored = pending[0];

  console.log('keys surviving the close :', keysOnDisk);
  console.log('badge after restart      :', JSON.stringify(badge.text), '|', badge.title);
  console.log('pending sessions          :', pending.length);
  console.log('lines restored            :', (restored && restored.lines || []).map(l => l.text));

  const dataSurvived = !!restored && restored.lines.length === 3;      // 2 committed + the half-spoken one
  const badgeShown = badge.text === '1' && /not exported/.test(badge.title);
  const hasTranscript = !!restored && /ship onboarding/.test(restored.transcript || '');

  // The popup must offer the same choices as the in-meeting prompt did.
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const offersAll = /Summarize/.test(popupJs) && /Export \.md/.test(popupJs) && /Export \.txt/.test(popupJs);

  // Exporting clears the badge.
  await call(w, { type: 'SAVE_SESSION', session: { id: sid, handled: true } });
  await new Promise(r => setTimeout(r, 30));
  const cleared = badge.text === '';

  console.log('---');
  console.log('transcript survived close :', dataSurvived ? 'PASS' : 'FAIL');
  console.log('half-spoken line kept     :', (restored && restored.lines.some(l => /pricing page/.test(l.text))) ? 'PASS' : 'FAIL');
  console.log('badge flags it after boot :', badgeShown ? 'PASS' : 'FAIL');
  console.log('transcript reassembled    :', hasTranscript ? 'PASS' : 'FAIL');
  console.log('popup offers md/txt/sum   :', offersAll ? 'PASS' : 'FAIL');
  console.log('badge clears on export    :', cleared ? 'PASS' : 'FAIL');

  const ok = dataSurvived && badgeShown && hasTranscript && offersAll && cleared;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
