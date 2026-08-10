// Regression test for what a real Zoom meeting actually looks like — the mock
// used earlier was too generous and hid three bugs:
//
//   1. the caption pill is wrapped in layout divs, so `block.children` is
//      [wrapper], and the "short first child is the speaker" rule never fires
//      -> initials stayed glued to the text ("AJ Hello, hello…")
//   2. the avatar has NO title/aria-label — only the initials "AJ" — so speaker
//      attribution fell back to the generic "Speaker"
//   3. the full name is nowhere in the caption markup; it only exists on the
//      video tile, so it has to be resolved from initials
//
// Run: npm i jsdom && node test/speaker-name.test.js

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

// Participant names exist only on the video tiles — never in the caption pill.
const stage = doc.createElement('div');
for (const n of ['Alex Johnson', 'Sarah Miller', 'Chris Lee']) {
  const tile = doc.createElement('div');
  const label = doc.createElement('span');
  label.textContent = n;
  tile.appendChild(label);
  stage.appendChild(tile);
}
doc.body.appendChild(stage);

// Caption area: wrapper > wrapper > pill(avatar-initials + text). No title attr.
const capOuter = doc.createElement('div');
doc.body.appendChild(capOuter);

const UTTERANCES = [
  ['AJ', 'Hello, hello, hello. Are you able to hear me'],
  ['SM', 'yes I can hear you clearly'],
  ['CL', 'same here all good'],
];

function newPill(initials) {
  const wrapper = doc.createElement('div');          // extra nesting layer
  const pill = doc.createElement('div');
  const av = doc.createElement('span');              // initials only, no title
  av.textContent = initials;
  const tx = doc.createElement('span');
  pill.appendChild(av); pill.appendChild(tx);
  wrapper.appendChild(pill);
  capOuter.appendChild(wrapper);
  return { wrapper, tx };
}

const A = window.LSAutoCapture.create({
  label: 'zoom real-shape',
  hints: [],
  onLine: (k, s, t) => window.LSCollector.update(k, s, t),
  onGone: (k) => window.LSCollector.finalize(k),
});
A.start();

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < UTTERANCES.length; i++) {
    const [initials, line] = UTTERANCES[i];
    const { wrapper, tx } = newPill(initials);
    for (const w of line.split(' ').map((_, n, arr) => arr.slice(0, n + 1).join(' '))) {
      tx.textContent = w; await sleep(15);
    }
    await sleep(120);
    if (i < UTTERANCES.length - 1) wrapper.remove();
  }
  await sleep(5000);   // stale-sweep worst case, then a few more scrape ticks

  const v = window.LSCollector.view();
  console.log('committed lines:', v.committed.length, '| still active:', v.active.length);
  console.log('---');
  v.committed.forEach(l => console.log(`  ${l.speaker}: ${l.text}`));
  if (v.active.length) v.active.forEach(l => console.log(`  (active) ${l.speaker}: ${l.text}`));
  console.log('---');

  const texts = v.committed.map(l => l.text);
  const speakers = v.committed.map(l => l.speaker);

  const noInitialPrefix = !texts.some(t => /^(AJ|SM|CL)\b/.test(t));
  const fullNames = speakers.includes('Alex Johnson') && speakers.includes('Sarah Miller');
  const notGeneric = !speakers.includes('Speaker');
  const gotAll = UTTERANCES.every(([, line]) => texts.includes(line));
  // The last utterance stays on screen after being committed; it must not also
  // linger as a duplicate "active" line.
  const noDupe = !v.active.some(a => texts.includes(a.text));

  console.log('initials stripped from text:', noInitialPrefix ? 'PASS' : 'FAIL');
  console.log('initials -> full name      :', fullNames ? 'PASS' : 'FAIL');
  console.log('no generic "Speaker"       :', notGeneric ? 'PASS' : 'FAIL');
  console.log('all utterances captured    :', gotAll ? 'PASS' : 'FAIL');
  console.log('no duplicate active line   :', noDupe ? 'PASS' : 'FAIL');

  const ok = noInitialPrefix && fullNames && notGeneric && gotAll && noDupe;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
