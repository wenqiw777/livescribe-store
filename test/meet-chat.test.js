// Google Meet chat must be retained, visibly distinguished from spoken captions,
// and committed immediately because chat messages do not grow by revision.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  url: 'https://meet.google.com/abc-defg-hij',
});
const { window } = dom;
const updates = [];
const finalized = [];

window.LSCollector = {
  update(key, speaker, text) { updates.push({ key, speaker, text }); },
  finalize(key) { finalized.push(key); },
};
window.LSPanel = {
  exists: () => true,
  mount() {},
  meetingEnded() {},
};
window.LSAutoCapture = {
  create: () => ({ start() {}, stop() {}, diagnose: () => ({ candidates: [] }) }),
};

window.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'meet.js'), 'utf8'));
window.document.documentElement.dispatchEvent(new window.CustomEvent('livescribe-meet', {
  detail: {
    type: 'chat',
    id: '1700000001/spaces/Room/devices/alex',
    speaker: 'Alex Johnson',
    text: 'The launch link is in chat',
  },
}));

const message = updates.find(update => update.text === 'The launch link is in chat');
assert(message, 'Meet chat reaches the collector');
assert.strictEqual(message.speaker, 'Alex Johnson · Chat',
  'chat is visibly distinguished from spoken transcript');
assert(finalized.includes(message.key), 'chat is committed immediately');

console.log('Google Meet chat routing: PASS');
process.exit(0);
