// Regression test: captions captured in a CHILD frame must reach the top frame.
//
// Zoom's web client spreads the meeting across nested frames, so the content
// script runs several times. Child frames forward captured lines up via
// postMessage. A message forwarded from a child arrives with ev.source set to
// THAT frame — so a `ev.source !== window` guard drops every one of them
// silently, and the panel sits on "Waiting for captions…" forever.
//
// Run: npm i jsdom && node test/frame-forward.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const dom = new JSDOM(`<!doctype html><body></body>`, {
  runScripts: 'outside-only', url: 'https://zoom.us/wc/8412/join',
});
const { window } = dom;

Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; }, set(v) { this.textContent = v; },
});

// Minimal stand-ins: we're testing zoom.js message routing, not capture/UI.
const updates = [];
window.LSCollector = {
  update: (k, s, t) => updates.push({ k, s, t }),
  finalize: () => {},
};
let mounted = 0;
window.LSPanel = { exists: () => mounted > 0, mount: () => { mounted++; } };
window.LSAutoCapture = { create: () => ({ start() {}, diagnose: () => ({ candidates: [] }) }) };

window.eval(fs.readFileSync(path.join(SRC, 'zoom.js'), 'utf8'));

// A child frame forwards a captured line. ev.source is the CHILD window.
// MessageEvent.source is getter-only, so it has to be defined, not assigned.
const fakeChild = { name: 'child-frame' };
function fromChild(data) {
  const ev = new window.MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { get: () => fakeChild });
  return ev;
}
window.dispatchEvent(fromChild({ __livescribe: true, type: 'LS_FRAME_LINE',
  payload: { key: 'fc1', speaker: 'Alex Johnson', text: 'Hello, hello, hello' } }));

// Same-frame WebSocket captions must still work (ev.source === window).
// Built explicitly: jsdom's postMessage leaves ev.source unset, whereas real
// browsers set it to the sending window.
function fromSelf(data) {
  const ev = new window.MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { get: () => window });
  return ev;
}
window.dispatchEvent(fromSelf({ __livescribe: true, type: 'LS_WS_CAPTION',
  payload: { text: 'captions over the wire', speaker: 'Chris Lee', id: 9 } }));

// A message from an unrelated origin must NOT be accepted as a caption.
window.dispatchEvent(fromChild({ __livescribe: true, type: 'LS_WS_CAPTION',
  payload: { text: 'spoofed', speaker: 'x' } }));

setTimeout(() => {
  const texts = updates.map(u => u.t);
  console.log('updates reaching collector:', JSON.stringify(texts));

  const frameOk = texts.includes('Hello, hello, hello');
  const wsOk = texts.includes('captions over the wire');
  const spoofRejected = !texts.includes('spoofed');
  const panelMounted = mounted > 0;

  console.log('child-frame line forwarded :', frameOk ? 'PASS' : 'FAIL');
  console.log('same-frame WS line kept    :', wsOk ? 'PASS' : 'FAIL');
  console.log('cross-frame WS spoof reject:', spoofRejected ? 'PASS' : 'FAIL');
  console.log('panel mounted in top frame :', panelMounted ? 'PASS' : 'FAIL');

  const ok = frameOk && wsOk && spoofRejected && panelMounted;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
}, 200);
