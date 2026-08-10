// End-of-meeting detection via a long-lived port, the way Tactiq does it.
//
// Everything in-page — polling the URL, watching the DOM, listening for
// pagehide — shares one flaw: when the tab is CLOSED, none of it gets to run,
// and the session is left looking as if it were still in progress. A port held
// open from the tab to the service worker inverts that: the worker outlives the
// tab, and the tab's disappearance is delivered to it as an event.
//
// Run: npm i jsdom && node test/tab-gone.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const disk = {};
const badge = { text: '' };

// --- a chrome.runtime.connect implementation good enough to be meaningful ---
function makePorts() {
  const hub = { onConnect: null };
  function connect(info) {
    const tabSide = { name: info.name, _msg: [], _dis: [] };
    const bgSide = { name: info.name, _msg: [], _dis: [] };
    tabSide.postMessage = m => bgSide._msg.forEach(f => f(m));
    tabSide.disconnect = () => bgSide._dis.forEach(f => f());
    bgSide.onMessage = { addListener: f => bgSide._msg.push(f) };
    bgSide.onDisconnect = { addListener: f => bgSide._dis.push(f) };
    if (hub.onConnect) hub.onConnect(bgSide);
    lastTabPort = tabSide;
    return tabSide;
  }
  return { hub, connect };
}

const ports = makePorts();
let lastTabPort = null;

function chromeApi(forWorker) {
  return {
    action: {
      setBadgeText: async o => { badge.text = o.text; },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    runtime: {
      lastError: null,
      connect: ports.connect,
      onConnect: { addListener: fn => { ports.hub.onConnect = fn; } },
      onStartup: { addListener: () => {} },
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: fn => { chromeApi._msg = fn; } },
      sendMessage: (msg, cb) => {
        if (!forWorker && chromeApi._msg) chromeApi._msg(msg, {}, r => cb && cb(r));
        else if (cb) cb({ ok: true });
      },
    },
    storage: {
      local: {
        get: async (k) => (k == null ? { ...disk } : (typeof k === 'string' ? { [k]: disk[k] } : {})),
        set: async (o) => { Object.assign(disk, o); },
        remove: async () => {},
      },
      sync: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
    },
  };
}

// --- service worker ---
const wDom = new JSDOM('', { runScripts: 'outside-only' });
wDom.window.chrome = chromeApi(true);
wDom.window.fetch = async () => ({ ok: false, json: async () => ({}) });
wDom.window.eval(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'));

// --- meeting tab ---
const tDom = new JSDOM('<!doctype html><body></body>', {
  runScripts: 'outside-only', url: 'https://app.zoom.us/wc/7/start', pretendToBeVisual: true,
});
const t = tDom.window;
t.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
Object.defineProperty(t.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; }, set(v) { this.textContent = v; },
});
t.chrome = chromeApi(false);
t.eval(fs.readFileSync(path.join(ROOT, 'src', 'collector.js'), 'utf8'));
t.eval(fs.readFileSync(path.join(ROOT, 'src', 'panel.js'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  t.LSPanel.mount('Zoom');
  t.document.querySelectorAll('#ls-panel .ls-consent .ls-btn')[0].click();
  await sleep(30);

  t.LSCollector.update('a', 'Alex Johnson', 'we ship onboarding on Friday');
  await sleep(30);
  t.LSCollector.finalize('a');
  await sleep(40);

  const sid = Object.keys(disk).find(k => k.startsWith('ls:m:'));
  const beforeClose = disk[sid];

  // The user closes the tab. No pagehide handler, no poll, no final message —
  // exactly the case in-page detection cannot cover. The browser severs the
  // port; that is the whole signal.
  lastTabPort.disconnect();

  await sleep(60);
  const afterClose = disk[sid];

  console.log('session before tab closed:', JSON.stringify({ ended: beforeClose && beforeClose.ended }));
  console.log('session after  tab closed:', JSON.stringify({ ended: afterClose && afterClose.ended, endedAt: !!(afterClose && afterClose.endedAt) }));
  console.log('badge                    :', JSON.stringify(badge.text));

  const wasOpen = !beforeClose || !beforeClose.ended;
  const nowEnded = !!(afterClose && afterClose.ended === true && afterClose.endedAt);
  const flagged = badge.text === '1';

  console.log('---');
  console.log('not marked ended while live :', wasOpen ? 'PASS' : 'FAIL');
  console.log('tab close marks it ended    :', nowEnded ? 'PASS' : 'FAIL');
  console.log('badge raised for the user   :', flagged ? 'PASS' : 'FAIL');

  const ok = wasOpen && nowEnded && flagged;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
