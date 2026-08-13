// Black-box resilience test for Google Meet's MAIN-world WebRTC capture.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html lang="en-US"><body></body></html>', {
  runScripts: 'outside-only',
  url: 'https://meet.google.com/abc-defg-hij',
});
const { window } = dom;
window.TextDecoder = require('util').TextDecoder;
window.TextEncoder = require('util').TextEncoder;
window.Blob = global.Blob;
window.DecompressionStream = global.DecompressionStream;
window.__LS_MEET_CONFIG__ = {
  batchMs: 15,
  chatBatchMs: 5,
  openDelayMs: 0,
  healthMs: 10,
  silenceMs: 25,
  maxRecoveries: 2,
  parseGapPackets: 3,
  subscribeAckMs: 20,
  disconnectGraceMs: 25,
};

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}
const tag = (field, wire) => varint((field << 3) | wire);
const pInt = (field, value) => [...tag(field, 0), ...varint(value)];
const pStr = (field, value) => {
  const bytes = [...Buffer.from(value, 'utf8')];
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
};
const pMsg = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];

function caption({ deviceId, messageId, version, text, nested = false }) {
  const message = [
    ...pStr(1, deviceId),
    ...pInt(2, messageId),
    ...pInt(3, version),
    ...pStr(6, text),
    ...pInt(8, 1),
  ];
  const wrapped = pMsg(1, message);
  const bytes = nested ? pMsg(5, pMsg(3, wrapped)) : wrapped;
  return new Uint8Array(bytes);
}

function rosterFrame(devices) {
  const list = devices.flatMap(d => pMsg(2, [...pStr(1, d.id), ...pStr(2, d.name)]));
  return new Uint8Array(pMsg(2, pMsg(2, list)));
}

function languagePacket(language) {
  const captionConfig = [...pStr(1, language), ...pStr(2, language)];
  const clientConfig = pMsg(9, captionConfig);
  const updateMask = pStr(1, 'client_config.caption_config');
  const captionUpdate = [...pMsg(1, clientConfig), ...pMsg(2, updateMask)];
  const command = [...pInt(1, 7), ...pMsg(3, captionUpdate)];
  return new Uint8Array(pMsg(1, pMsg(2, command)));
}

function chatMessage({ deviceId, timestamp, text, wrapped = true }) {
  const message = [
    ...pStr(2, deviceId),
    ...pInt(3, timestamp),
    ...pMsg(5, pStr(1, text)),
  ];
  if (!wrapped) return new Uint8Array(message);
  return new Uint8Array(pMsg(1, pMsg(2, pMsg(13, pMsg(4, pMsg(2, message))))));
}

const deviceId = 'spaces/Room/devices/alex';
const initialRoster = rosterFrame([{ id: deviceId, name: 'Alex Johnson' }]);

window.fetch = async (input) => {
  const url = String(input);
  if (url.includes('SyncMeetingSpaceCollections')) {
    return {
      url,
      clone() { return this; },
      async text() { return Buffer.from(initialRoster).toString('base64'); },
    };
  }
  if (url.includes('MeetingMessageService/CreateMeetingMessage')) {
    const selfChat = chatMessage({
      deviceId,
      timestamp: 1700000003,
      text: 'Message sent by this user',
    });
    return {
      url,
      clone() { return this; },
      async text() { return Buffer.from(selfChat).toString('base64'); },
    };
  }
  return { url, clone() { return this; }, async text() { return ''; } };
};

const channels = [];
class FakeChannel {
  constructor(label, options = {}) {
    this.label = label;
    this.id = options.id;
    this.readyState = 'open';
    this.sent = [];
    this.listeners = {};
    channels.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  send(data) { this.sent.push(data); }
  fire(data) {
    for (const fn of this.listeners.message || []) fn({ data });
  }
  close() {
    this.readyState = 'closed';
    for (const fn of this.listeners.close || []) fn();
  }
}

let audioEnergy = 0;
class FakePC {
  constructor() {
    this.connectionState = 'connected';
    this.listeners = {};
    FakePC.last = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  createDataChannel(label, options) { return new FakeChannel(label, options); }
  emitRemote(channel) {
    for (const fn of this.listeners.datachannel || []) fn({ channel });
  }
  emitConnectionState() {
    for (const fn of this.listeners.connectionstatechange || []) fn();
  }
  async getStats() {
    return new Map([['audio', {
      type: 'inbound-rtp',
      kind: 'audio',
      totalAudioEnergy: audioEnergy,
    }]]);
  }
}
window.RTCPeerConnection = FakePC;

const events = [];
window.document.documentElement.addEventListener('livescribe-meet', event => {
  events.push(event.detail);
});

window.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'meetrtc.js'), 'utf8'));
const pc = new window.RTCPeerConnection();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(5);
  }
  return predicate();
}

(async () => {
  const earlyMessages = pc.createDataChannel('meet_messages');
  earlyMessages.fire(chatMessage({
    deviceId,
    timestamp: 1700000000,
    text: 'Chat arrived before the roster',
  }).buffer);

  // Seed the participant roster from the pre-meeting collections endpoint.
  await window.fetch('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections');
  assert(await waitFor(() => events.some(event => event.type === 'chat' &&
      event.text === 'Chat arrived before the roster' && event.speaker === 'Alex Johnson')),
    'chat waits briefly for the initial roster before resolving its speaker');

  const media = new FakeChannel('media-session');
  pc.emitRemote(media);
  await wait(10);

  const firstCaptions = channels.find(channel => channel.label === 'captions');
  assert(firstCaptions, 'capture opens a captions data channel');
  assert(media.sent.length >= 3, 'capture sends language configuration plus acknowledgements');
  media.send(languagePacket('fr-FR'));
  assert.strictEqual(window.__ls_meet.lang, 'fr-FR',
    'Meet-originated media-session language changes become the active caption language');

  // Meet chat is a separate message type. Google can surface the same packet
  // on meet_messages and collections, so the capture must deduplicate it.
  const meetMessages = pc.createDataChannel('meet_messages');
  const collections = new FakeChannel('collections');
  pc.emitRemote(collections);
  const wrappedChat = chatMessage({
    deviceId,
    timestamp: 1700000001,
    text: 'The launch link is in chat',
  });
  meetMessages.fire(wrappedChat.buffer);
  collections.fire(wrappedChat.buffer);

  const bareChat = chatMessage({
    deviceId,
    timestamp: 1700000002,
    text: 'This is a second chat message',
    wrapped: false,
  });
  collections.fire(bareChat.buffer);
  assert(await waitFor(() => events.filter(event => event.type === 'chat').length >= 3),
    'chat events are flushed after their short roster-resolution window');
  const chatEvents = events.filter(event => event.type === 'chat');
  assert.strictEqual(chatEvents.filter(event => event.text === 'The launch link is in chat').length, 1,
    'the same chat packet arriving on two channels is emitted once');
  assert(chatEvents.some(event => event.text === 'This is a second chat message'),
    'a bare chat protobuf is accepted as a compatibility path');
  assert(chatEvents.every(event => event.speaker === 'Alex Johnson'),
    'chat device ids resolve through the meeting roster');

  await window.fetch('https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingMessageService/CreateMeetingMessage');
  assert(await waitFor(() => events.some(event =>
    event.type === 'chat' && event.text === 'Message sent by this user')),
    'the CreateMeetingMessage response captures chat sent by the local user');

  const remoteMessages = new FakeChannel('meet_messages');
  pc.emitRemote(remoteMessages);
  const compressedChat = zlib.gzipSync(Buffer.from(chatMessage({
    deviceId,
    timestamp: 1700000004,
    text: 'Compressed remote chat message',
  })));
  remoteMessages.fire(compressedChat.buffer.slice(
    compressedChat.byteOffset,
    compressedChat.byteOffset + compressedChat.byteLength,
  ));
  assert(await waitFor(() => events.some(event =>
    event.type === 'chat' && event.text === 'Compressed remote chat message')),
    'a remote Meet messages channel accepts gzip-wrapped chat');

  const version1 = caption({ deviceId, messageId: 41, version: 1, text: 'ship on' });
  const version2 = caption({ deviceId, messageId: 41, version: 2, text: 'ship on Friday' });
  firstCaptions.fire(version1.buffer);
  firstCaptions.fire(version2.buffer);

  const nested = caption({ deviceId, messageId: 42, version: 1, text: 'nested packet decoded', nested: true });
  firstCaptions.fire(nested.buffer);

  const compressed = zlib.gzipSync(Buffer.from(caption({
    deviceId,
    messageId: 43,
    version: 1,
    text: 'compressed packet decoded',
  })));
  firstCaptions.fire(compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength));
  await wait(60);

  const speech = events.filter(event => event.type === 'speech');
  assert.strictEqual(speech.filter(event => event.id === `41/${deviceId}`).length, 1,
    'short-lived revisions are batched into one speech event');
  assert(speech.some(event => event.text === 'ship on Friday' && event.speaker === 'Alex Johnson'),
    'latest revision uses the initial roster display name');
  assert(speech.some(event => event.text === 'nested packet decoded'),
    'recursive protocol fallback decodes a nested wrapper');
  assert(speech.some(event => event.text === 'compressed packet decoded'),
    'gzip caption packet is decompressed');

  // Repeated unparseable packets produce one actionable diagnostic.
  firstCaptions.fire(new Uint8Array([1, 2, 3]).buffer);
  firstCaptions.fire(new Uint8Array([4, 5, 6]).buffer);
  firstCaptions.fire(new Uint8Array([7, 8, 9]).buffer);
  await wait(10);
  assert(events.some(event => event.type === 'diagnostic' && event.code === 'caption-parse-gap'),
    'schema drift emits a parse-gap diagnostic');

  const beforeClose = channels.filter(channel => channel.label === 'captions').length;
  firstCaptions.close();
  await wait(20);
  assert(channels.filter(channel => channel.label === 'captions').length > beforeClose,
    'closing the active captions channel opens a replacement');

  const replacement = window.__ls_meet.cc;
  const remoteCaptions = new FakeChannel('captions', { id: 60001 });
  pc.emitRemote(remoteCaptions);
  assert.strictEqual(window.__ls_meet.cc, remoteCaptions,
    'a newer remote captions channel becomes active');
  const beforeStaleClose = channels.filter(channel => channel.label === 'captions').length;
  replacement.close();
  await wait(20);
  assert.strictEqual(channels.filter(channel => channel.label === 'captions').length, beforeStaleClose,
    'closing a stale captions channel does not open another replacement');

  // Audio energy advancing without caption packets triggers silence recovery.
  const beforeSilence = channels.filter(channel => channel.label === 'captions').length;
  audioEnergy = 1;
  await wait(15);
  audioEnergy = 2;
  await wait(45);
  assert(channels.filter(channel => channel.label === 'captions').length > beforeSilence,
    'audio energy plus caption silence opens a recovery channel');

  const captionIds = channels.filter(channel => channel.label === 'captions').map(channel => channel.id);
  assert(captionIds.filter(Number.isInteger).length === captionIds.length,
    'self-opened caption channels use explicit numeric ids');
  assert(new Set(captionIds).size === captionIds.length,
    'self-opened caption channel ids do not collide');

  // A brief network transition must not end the meeting or create a settlement.
  const endedBeforeDisconnect = events.filter(event => event.type === 'ended').length;
  pc.connectionState = 'disconnected';
  pc.emitConnectionState();
  await wait(5);
  pc.connectionState = 'connected';
  pc.emitConnectionState();
  await wait(35);
  assert.strictEqual(events.filter(event => event.type === 'ended').length, endedBeforeDisconnect,
    'transient peer disconnection does not end the meeting');

  // Starting a second meeting in the same Meet tab must get a fresh recovery
  // budget and a live silence watchdog after the first meeting ends.
  pc.connectionState = 'closed';
  pc.emitConnectionState();
  assert.strictEqual(events.filter(event => event.type === 'ended').length, endedBeforeDisconnect + 1,
    'closing the current peer connection ends only the current meeting');

  const secondMeeting = new window.RTCPeerConnection();
  await wait(10);
  assert.strictEqual(window.__ls_meet.recoveries, 0,
    'a new peer connection resets the per-meeting recovery budget');

  const secondInitial = window.__ls_meet.cc;
  const beforeSecondClose = channels.filter(channel => channel.label === 'captions').length;
  secondInitial.close();
  await wait(20);
  assert(channels.filter(channel => channel.label === 'captions').length > beforeSecondClose,
    'the second meeting can recover from an active caption channel close');

  const beforeSecondSilence = channels.filter(channel => channel.label === 'captions').length;
  audioEnergy = 10;
  await wait(15);
  audioEnergy = 11;
  await wait(45);
  assert(channels.filter(channel => channel.label === 'captions').length > beforeSecondSilence,
    'the silence watchdog remains active for the second meeting');

  console.log('Google Meet resilience behavior: PASS');
  process.exit(0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
