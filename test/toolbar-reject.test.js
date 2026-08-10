// Regression test for the failure seen in a real Zoom meeting: auto-discovery
// locked onto meeting CHROME instead of the caption box.
//
// Two decoys compete with the real captions:
//   1. a toolbar whose text churns constantly (timer, mute state) and which
//      therefore out-scores captions on "text keeps changing" alone
//   2. a STATIC aria-live accessibility region ("Press shift+F10 …") that a
//      naive aria-live hint locks onto immediately even though it never updates
//
// Run: npm i jsdom && node test/toolbar-reject.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const dom = new JSDOM(`<!doctype html><body></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; }, set(v) { this.textContent = v; },
});

window.eval(fs.readFileSync(path.join(SRC, 'collector.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(SRC, 'autocapture.js'), 'utf8'));

const doc = window.document;

// --- decoy 1: static aria-live accessibility text (matches the aria-live hint)
const a11y = doc.createElement('div');
a11y.setAttribute('aria-live', 'polite');
a11y.textContent = 'In a Zoom meeting: Home Meetings Press shift+F10 to open the context menu.';
doc.body.appendChild(a11y);

// --- decoy 2: toolbar full of controls, text churns every tick
const toolbar = doc.createElement('div');
toolbar.innerHTML = `<button>Mute</button><button>Video</button><button>Participants</button>
  <button>Chat</button><button>Share</button><button>Host tools</button><span id="clock">00:01</span>`;
doc.body.appendChild(toolbar);

// --- the real caption box: plain text, no controls
const capWrap = doc.createElement('div');
doc.body.appendChild(capWrap);

const UTTERANCES = [
  ['Alex Johnson', 'Hello, hello, hello'],
  ['Sarah Miller', 'can everyone hear me okay'],
  ['Chris Lee', 'yes we can hear you fine'],
  ['Alex Johnson', 'great lets start with the roadmap'],
];

function newPill(speaker) {
  const p = doc.createElement('div');
  const av = doc.createElement('span');
  av.setAttribute('title', speaker);
  av.textContent = speaker.split(' ').map(w => w[0]).join('').toUpperCase();
  const tx = doc.createElement('span');
  // Zoom's caption bubble carries a small icon/control of its own. Rejecting a
  // candidate for containing ANY control killed real captures, so one control
  // must still be allowed here.
  const icon = doc.createElement('button');
  icon.setAttribute('aria-label', 'caption options');
  p.appendChild(av); p.appendChild(tx); p.appendChild(icon);
  capWrap.appendChild(p);
  return { p, tx };
}

const A = window.LSAutoCapture.create({
  label: 'zoom test',
  hints: ['[aria-live="polite"]'],
  onLine: (k, s, t) => window.LSCollector.update(k, s, t),
  onGone: (k) => window.LSCollector.finalize(k),
});
A.start();

const sleep = ms => new Promise(r => setTimeout(r, ms));
let tick = 1;
const clockTimer = setInterval(() => {   // toolbar churns the whole time
  const c = doc.getElementById('clock');
  if (c) c.textContent = '00:' + String(++tick).padStart(2, '0');
}, 25);

(async () => {
  for (let i = 0; i < UTTERANCES.length; i++) {
    const [speaker, line] = UTTERANCES[i];
    const { p, tx } = newPill(speaker);
    for (const w of line.split(' ').map((_, n, arr) => arr.slice(0, n + 1).join(' '))) {
      tx.textContent = w; await sleep(15);
    }
    await sleep(80);
    if (i < UTTERANCES.length - 1) p.remove();
  }
  clearInterval(clockTimer);
  await sleep(5000);   // stale-sweep worst case = STALE_MS(2500) + sweep interval(1000), plus slack

  const v = window.LSCollector.view();
  const c = A.container();
  console.log('locked container tag  :', c ? c.tagName : '(none)');
  console.log('locked inside caption :', c ? capWrap.contains(c) || c === capWrap : false);
  console.log('captured lines        :', v.committed.length);
  console.log('---');
  v.committed.forEach(l => console.log(`  ${l.speaker}: ${l.text}`));
  console.log('---');

  const texts = v.committed.map(l => l.text);
  const inCaptionBox = !!c && (c === capWrap || capWrap.contains(c));
  const noToolbar = !texts.some(t => /Mute|Participants|Host tools|Share/.test(t));
  const noA11y = !texts.some(t => /shift\+F10|In a Zoom meeting/.test(t));
  const gotSpeech = UTTERANCES.every(([, line]) => texts.includes(line));
  const speakersOk = v.committed.some(l => l.speaker === 'Alex Johnson')
                  && v.committed.some(l => l.speaker === 'Chris Lee');

  console.log('locked on caption box :', inCaptionBox ? 'PASS' : 'FAIL');
  console.log('toolbar text rejected :', noToolbar ? 'PASS' : 'FAIL');
  console.log('static aria-live rej. :', noA11y ? 'PASS' : 'FAIL');
  console.log('all utterances caught :', gotSpeech ? 'PASS' : 'FAIL');
  console.log('speaker attribution   :', speakersOk ? 'PASS' : 'FAIL');

  const ok = inCaptionBox && noToolbar && noA11y && gotSpeech && speakersOk;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
