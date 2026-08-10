// Zero-loss test: the tab dies with NO clean shutdown — no meetingEnded, no
// pagehide, no final save. Whatever was spoken must still be recoverable.
//
// This is the case a periodic autosave cannot cover: with a 30s timer, anything
// said since the last tick is gone. Persisting each line as it is finalised (and
// mirroring the half-spoken one) removes that window entirely.
//
// Run: npm i jsdom && node test/crash-loss.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');

// Storage that behaves like the background service worker's, so the test
// exercises the real key layout rather than a stub.
const disk = {};
function chromeFor(win) {
  return {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        let res = { ok: true };
        if (msg.type === 'APPEND_LINES') {
          msg.lines.forEach((l, i) => { disk[`ls:l:${msg.sessionId}:${msg.from + i}`] = l; });
        } else if (msg.type === 'SET_PENDING') {
          if (msg.line) disk[`ls:p:${msg.sessionId}`] = msg.line;
          else delete disk[`ls:p:${msg.sessionId}`];
        } else if (msg.type === 'SAVE_SESSION') {
          const k = `ls:m:${msg.session.id}`;
          disk[k] = { ...(disk[k] || {}), ...msg.session };
        } else if (msg.type === 'GET_SESSIONS') {
          res = { sessions: assemble() };
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

function assemble() {
  const byId = new Map();
  for (const [k, v] of Object.entries(disk)) {
    const m = /^ls:(m|l|p):([^:]+)(?::(\d+))?$/.exec(k);
    if (!m) continue;
    const [, kind, sid, idx] = m;
    if (!byId.has(sid)) byId.set(sid, { id: sid, lines: [], _p: null });
    const r = byId.get(sid);
    if (kind === 'm') Object.assign(r, v);
    else if (kind === 'l') r.lines[Number(idx)] = v;
    else r._p = v;
  }
  return [...byId.values()].map(r => {
    r.lines = r.lines.filter(Boolean);
    if (r._p && r._p.text) r.lines.push(r._p);
    delete r._p;
    r.transcript = r.lines.map(l => `${l.speaker}: ${l.text}`).join('\n');
    return r;
  });
}

function newPage() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    runScripts: 'outside-only', url: 'https://app.zoom.us/wc/9/start', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; },
  });
  window.chrome = chromeFor(window);
  window.eval(fs.readFileSync(path.join(SRC, 'collector.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'));
  return window;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SPOKEN = [
  ['Alex Johnson', 'we should cut the dashboard from v1'],
  ['Sarah Miller', 'I can take QA on Thursday'],
  ['Chris Lee', 'email verification is the last backend piece'],
  ['Prisha', 'lets align on the launch date first'],
];

(async () => {
  const w = newPage();
  w.LSPanel.mount('Zoom');
  w.document.querySelectorAll('#ls-panel .ls-consent .ls-btn')[0].click();

  // Speak four full utterances, each committed by the collector.
  for (let i = 0; i < SPOKEN.length; i++) {
    const [spk, text] = SPOKEN[i];
    w.LSCollector.update('k' + i, spk, text);
    await sleep(30);
    w.LSCollector.finalize('k' + i);            // utterance ends
    await sleep(30);
  }

  // A fifth is HALF SPOKEN and never finalised...
  w.LSCollector.update('k9', 'Alex Johnson', 'and the pricing page still needs');
  await sleep(60);

  // ...and now the tab is killed. No meetingEnded(), no pagehide, no final save.
  const recovered = assemble()[0];
  const texts = (recovered.lines || []).map(l => l.text);

  console.log('lines recovered after an abrupt kill:', texts.length);
  texts.forEach(t => console.log('   ', t));
  console.log('---');

  const allFinalised = SPOKEN.every(([, t]) => texts.some(x => x.includes(t)));
  const partialKept = texts.some(t => t.includes('pricing page still needs'));

  console.log('every finished line survived :', allFinalised ? 'PASS' : 'FAIL');
  console.log('half-spoken line survived    :', partialKept ? 'PASS' : 'FAIL');

  const ok = allFinalised && partialKept;
  console.log(ok ? '\n✅ nothing lost' : '\n❌ DATA LOST');
  process.exit(ok ? 0 : 1);
})();
