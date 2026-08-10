// Tests the Google Meet WebRTC tap.
//
// Meet streams captions over a data channel labelled "captions" rather than
// keeping them in app state, and its media server will serve that channel to
// one WE open — which is why captions need not be enabled in the UI first.
// Payload is protobuf with an unpublished schema, so the reader walks the wire
// format generically and picks the caption text by shape.
//
// Run: npm i jsdom && node test/meetrtc.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', {
  runScripts: 'outside-only', url: 'https://meet.google.com/abc-defg-hij',
});
const { window } = dom;
window.TextDecoder = require('util').TextDecoder;

// --- fake WebRTC ----------------------------------------------------------
const channels = [];
class FakeChannel {
  constructor(label) { this.label = label; this._l = {}; channels.push(this); }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  fire(data) { (this._l.message || []).forEach(fn => fn({ data })); }
}
class FakePC {
  constructor() { this._l = {}; FakePC.last = this; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  createDataChannel(label) { return new FakeChannel(label); }
  emitRemote(ch) { (this._l.datachannel || []).forEach(fn => fn({ channel: ch })); }
}
window.RTCPeerConnection = FakePC;

window.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'meetrtc.js'), 'utf8'));

const got = [];
window.document.documentElement.addEventListener('livescribe-meet', ev => got.push(ev.detail));

// --- encode frames using Meet's ACTUAL schema -------------------------------
//   BTranscriptMessageWrapper { message = 1 -> BTranscriptMessage {
//     deviceId = 1 (string), messageId = 2 (int64),
//     messageVersion = 3 (int64), text = 6 (string), langId = 8 (int64) } }
//   BMeetingCollection { 2 -> { 2 -> repeated 2 -> { deviceId=1, deviceName=2 } } }
function varint(n) { const o = []; while (n > 127) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; }
const tag = (f, w) => varint((f << 3) | w);
const pStr = (f, v) => { const b = [...Buffer.from(v, 'utf8')]; return [...tag(f, 2), ...varint(b.length), ...b]; };
const pInt = (f, v) => [...tag(f, 0), ...varint(v)];
const pMsg = (f, inner) => [...tag(f, 2), ...varint(inner.length), ...inner];

function caption({ deviceId, messageId, version, text }) {
  const msg = [...pStr(1, deviceId), ...pInt(2, messageId), ...pInt(3, version), ...pStr(6, text), ...pInt(8, 1)];
  return new Uint8Array(pMsg(1, msg)).buffer;
}
function rosterFrame(devices) {
  const list = devices.flatMap(d => pMsg(2, [...pStr(1, d.id), ...pStr(2, d.name)]));
  return new Uint8Array(pMsg(2, pMsg(2, list))).buffer;
}

const pc = new window.RTCPeerConnection();


setTimeout(() => {
  const opened = channels.filter(c => c.label === 'captions');
  const selfOpened = opened.length >= 1;

  // The roster arrives on its own channel and must name the speakers.
  const coll = new FakeChannel('collections');
  pc.emitRemote(coll);
  coll.fire(rosterFrame([
    { id: 'spaces/AbC/devices/9f3k2mQ', name: 'Alex Johnson' },
    { id: 'spaces/AbC/devices/7hT1pQz', name: 'Sarah Miller' },
  ]));

  opened[0].fire(caption({ deviceId: 'spaces/AbC/devices/9f3k2mQ', messageId: 41, version: 1,
                           text: 'we should cut the dashboard from v1' }));

  // A revision of the SAME utterance keeps the same messageId.
  opened[0].fire(caption({ deviceId: 'spaces/AbC/devices/9f3k2mQ', messageId: 41, version: 2,
                           text: 'we should cut the dashboard from v1 and keep scope tight' }));

  const remote = new FakeChannel('captions');
  pc.emitRemote(remote);
  remote.fire(caption({ deviceId: 'spaces/AbC/devices/7hT1pQz', messageId: 42, version: 1,
                        text: 'agreed, ship on Friday' }));

  const other = new FakeChannel('media-stats');
  pc.emitRemote(other);
  other.fire(new Uint8Array(pMsg(1, pStr(6, 'bitrate 900000 ssrc 12345'))).buffer);

  setTimeout(() => {
    console.log('captions channel opened by us:', selfOpened ? 'PASS' : 'FAIL');
    console.log('speech events              :', got.length);
    console.log('---');
    got.forEach(g => console.log(`  [${g.id}] ${g.speaker || '(unnamed)'}: ${g.text}`));
    console.log('---');

    const texts = got.map(g => g.text);
    const decoded = texts.includes('we should cut the dashboard from v1');
    const named = got.some(g => g.speaker === 'Alex Johnson') && got.some(g => g.speaker === 'Sarah Miller');
    const remoteOk = texts.includes('agreed, ship on Friday');
    const sameId = got.filter(g => g.id === '41/spaces/AbC/devices/9f3k2mQ').length === 2;
    const ignored = !texts.some(t => /bitrate|ssrc/.test(t));

    console.log('decoded with real schema   :', decoded ? 'PASS' : 'FAIL');
    console.log('speaker names from roster  :', named ? 'PASS' : 'FAIL');
    console.log('remote captions channel    :', remoteOk ? 'PASS' : 'FAIL');
    console.log('revision keeps same id     :', sameId ? 'PASS' : 'FAIL');
    console.log('other channels ignored     :', ignored ? 'PASS' : 'FAIL');

    const ok = selfOpened && decoded && named && remoteOk && sameId && ignored;
    console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
    process.exit(ok ? 0 : 1);
  }, 150);
}, 1800);
