// Headless test of LiveScribe caption auto-discovery against a hostile mock:
//  * random class names (nothing says "caption")
//  * a NEW pill node per utterance (node churn)
//  * the caption box is MOVED + RE-PARENTED mid-stream (simulates dragging)
// Only getBoundingClientRect is stubbed (jsdom returns zeros for everything);
// discovery, scoring, MutationObserver and extraction are the real code.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const dom = new JSDOM(`<!doctype html><body><div id="stage"></div></body>`, {
  runScripts: 'outside-only', pretendToBeVisual: true,
});
const { window } = dom;

// stub layout (jsdom has no layout engine)
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 200, height: 30, top: 0, left: 0, right: 200, bottom: 30 };
};
// jsdom lacks innerText; approximate with textContent
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
  set(v) { this.textContent = v; },
});

window.eval(fs.readFileSync(`${SRC}/collector.js`, 'utf8'));
window.eval(fs.readFileSync(`${SRC}/autocapture.js`, 'utf8'));

const doc = window.document;
const stage = doc.getElementById('stage');
const rnd = () => 'x' + Math.random().toString(36).slice(2, 8);

const UTTERANCES = [
  ['Sarah Miller', "product that solves, like, every feature for as a startup, right?"],
  ['Alex Johnson', "I think we should narrow the scope before Friday."],
  ['Chris Lee', "Agreed, let's cut the dashboard from v1."],
  ['Sarah Miller', "Okay so I'll own the API and Alex takes the frontend."],
];

let movedContainer = null, pill = null;

function newPill(speaker) {
  const p = doc.createElement('div');
  p.className = 'pill ' + rnd();
  const av = doc.createElement('span');
  av.className = 'av ' + rnd();
  av.setAttribute('title', speaker);
  av.textContent = speaker.split(' ').map(w => w[0]).join('').toUpperCase();
  const tx = doc.createElement('span');
  tx.className = rnd();
  p.appendChild(av); p.appendChild(tx);
  (movedContainer || stage).appendChild(p);
  return { p, tx };
}

function dragTheBox() {
  movedContainer = doc.createElement('div');
  movedContainer.className = rnd();
  stage.appendChild(movedContainer);
  if (pill) movedContainer.appendChild(pill);   // re-parent the LIVE node
}

const A = window.LSAutoCapture.create({
  label: 'mock zoom',
  hints: ['[aria-live="polite"][class*="caption" i]'],   // intentionally never matches
  onLine: (k, s, t) => window.LSCollector.update(k, s, t),
  onGone: (k) => window.LSCollector.finalize(k),
});
A.start();

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let draggedAfter = null;
  for (let i = 0; i < UTTERANCES.length; i++) {
    const [speaker, line] = UTTERANCES[i];
    const { p, tx } = newPill(speaker);
    pill = p;
    const words = line.split(' ');
    for (let w = 0; w < words.length; w++) {
      tx.textContent = words.slice(0, w + 1).join(' ');
      await sleep(12);
    }
    await sleep(80);
    if (i === 1) { dragTheBox(); draggedAfter = i; await sleep(120); }
    if (i < UTTERANCES.length - 1) p.remove();
  }
  await sleep(5000);   // stale-sweep worst case = STALE_MS(2500) + sweep interval(1000), plus slack   // let the collector's stale-sweep commit the last line

  const v = window.LSCollector.view();
  console.log('locked onto container :', A.isLocked());
  console.log('box was dragged after :  utterance #' + (draggedAfter + 1));
  console.log('captured lines        :', v.committed.length);
  console.log('---');
  v.committed.forEach(l => console.log(`  ${l.speaker}: ${l.text}`));
  console.log('---');

  const got = v.committed.map(l => l.text);
  const expectedTails = UTTERANCES.slice(2).map(u => u[1]);   // lines AFTER the drag
  const postDragOk = expectedTails.every(t => got.some(g => g === t));
  const preDragOk = got.some(g => g === UTTERANCES[0][1]);
  const speakersOk = v.committed.some(l => l.speaker === 'Sarah Miller')
                  && v.committed.some(l => l.speaker === 'Chris Lee');
  const noPhantom = !v.committed.some(l => /^(SM|AJ|CL)$/.test(l.text));

  console.log('pre-drag capture   :', preDragOk ? 'PASS' : 'FAIL');
  console.log('POST-DRAG capture  :', postDragOk ? 'PASS' : 'FAIL');
  console.log('speaker attribution:', speakersOk ? 'PASS' : 'FAIL');
  console.log('no phantom avatar  :', noPhantom ? 'PASS' : 'FAIL');
  const ok = preDragOk && postDragOk && speakersOk && noPhantom;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
