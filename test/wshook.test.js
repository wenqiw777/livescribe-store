// Tests the MAIN-world WebSocket tap: does patching survive, and does the
// extractor pull caption records out of plausible wire formats (plain JSON,
// nested JSON, JSON embedded in a binary frame) without false-positiving on
// ordinary signalling traffic?
//
// Run: npm i jsdom && node test/wshook.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const dom = new JSDOM(`<!doctype html><body></body>`, { runScripts: 'outside-only', url: 'https://zoom.us/wc/123' });
const { window } = dom;

// jsdom has no WebSocket server; stub a native WebSocket we can drive by hand.
class FakeWS {
  constructor(url) { this.url = url; this._l = {}; FakeWS.last = this; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  send() {}
  fire(data) { (this._l.message || []).forEach(fn => fn({ data })); }
}
window.WebSocket = FakeWS;
window.TextDecoder = require('util').TextDecoder;

window.eval(fs.readFileSync(path.join(SRC, 'wshook.js'), 'utf8'));

const captured = [];
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m && m.__livescribe && m.type === 'LS_WS_CAPTION') captured.push(m.payload);
});

// The page opens a socket AFTER the hook is installed (document_start ordering).
const ws = new window.WebSocket('wss://rwg.zoom.us/wc/media');
const sock = FakeWS.last;

const enc = new (require('util').TextEncoder)();
const CASES = [
  ['plain json caption',
    JSON.stringify({ evt: 4405, body: { text: 'we should cut the dashboard from v1', username: 'Chris Lee', seq: 12 } })],
  ['nested list of sentences',
    JSON.stringify({ body: { sentences: [{ content: 'okay I will own the API', speakerName: 'Sarah Miller', id: 7 }] } })],
  ['json inside a binary frame',
    enc.encode('\x00\x12\x08' + JSON.stringify({ caption: 'narrow the scope before Friday', displayName: 'Alex Johnson' }) + '\x00').buffer],
  ['ordinary signalling (should NOT emit)',
    JSON.stringify({ evt: 1001, body: { ssrc: 288371, bitrate: 900000, uuid: 'a3f1c2d4e5b67890abcd1234ef567890' } })],
  ['heartbeat (should NOT emit)', JSON.stringify({ evt: 0, body: { ts: 1723456789 } })],
];

for (const [, payload] of CASES) sock.fire(payload);

// WebSocket's default binaryType is "blob" — the most likely real-world shape,
// and async to read. Drive it separately.
const BLOB_TEXT = 'lets ship the onboarding flow on Friday';
let blobSupported = false;
try {
  const b = new window.Blob([JSON.stringify({ body: { text: BLOB_TEXT, speaker: 'Taylor Morgan' } })]);
  if (typeof b.arrayBuffer === 'function') { blobSupported = true; sock.fire(b); }
} catch (e) { /* jsdom without Blob.arrayBuffer */ }

setTimeout(() => {
  console.log('hook installed        :', window.WebSocket !== FakeWS);
  console.log('captions extracted    :', captured.length);
  console.log('---');
  captured.forEach(c => console.log(`  [${c.speaker || '?'}] ${c.text}`));
  console.log('---');

  const texts = captured.map(c => c.text);
  const want = [
    'we should cut the dashboard from v1',
    'okay I will own the API',
    'narrow the scope before Friday',
  ];
  const gotAll = want.every(w => texts.includes(w));
  const speakersOk = captured.some(c => c.speaker === 'Chris Lee')
                  && captured.some(c => c.speaker === 'Sarah Miller')
                  && captured.some(c => c.speaker === 'Alex Johnson');
  const noNoise = !texts.some(t => /ssrc|bitrate|a3f1c2d4/.test(t));

  console.log('extract plain json    :', texts.includes(want[0]) ? 'PASS' : 'FAIL');
  console.log('extract nested        :', texts.includes(want[1]) ? 'PASS' : 'FAIL');
  console.log('extract binary-wrapped:', texts.includes(want[2]) ? 'PASS' : 'FAIL');
  console.log('speaker attribution   :', speakersOk ? 'PASS' : 'FAIL');
  console.log('no signalling noise   :', noNoise ? 'PASS' : 'FAIL');
  const blobOk = !blobSupported || texts.includes(BLOB_TEXT);
  console.log('blob frame (async)    :', blobSupported ? (blobOk ? 'PASS' : 'FAIL') : 'SKIPPED (no Blob.arrayBuffer)');

  const ok = gotAll && speakersOk && noNoise && blobOk;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
}, 300);
