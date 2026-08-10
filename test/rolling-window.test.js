// Regression test for the worst bug seen in a real meeting: the transcript
// recorded the same speech three times over.
//
// Zoom's caption box is a ROLLING WINDOW — several sentences are visible at
// once, and old ones scroll off the top. Read as a single line, consecutive
// reads overlap heavily:
//     "A B C"  ->  "B C D"  ->  "C D E"
// Committing each read verbatim produced the screenshot where line 2 contained
// line 3's opening and line 3 contained line 4's, all attributed to one speaker.
//
// Run: npm i jsdom && node test/rolling-window.test.js

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const { window } = dom;
window.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'collector.js'), 'utf8'));
const C = window.LSCollector;

// The real sentences spoken, in order.
const SPOKEN = [
  "Hi, I'm Prisha, first day.",
  "Hi, everyone.",
  "Welcome to this video and this will be a full walkthrough of my Agentic engineering workflow.",
  "My name is Kun.",
  "I was previously an L8 principal engineer, worked at Meta, Microsoft, and Atlassian.",
  "Windows and Facebook Games.",
];

// Simulate the caption widget: it shows the last N sentences, growing word by
// word, and scrolls older ones out.
const WINDOW_SENTENCES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const shown = [];
  for (let i = 0; i < SPOKEN.length; i++) {
    const words = SPOKEN[i].split(' ');
    for (let w = 1; w <= words.length; w++) {
      const partial = words.slice(0, w).join(' ');
      const visible = [...shown, partial].slice(-WINDOW_SENTENCES).join(' ');
      C.update('cap', 'Alex Johnson', visible);      // one key: the whole window
      await sleep(8);
    }
    shown.push(SPOKEN[i]);
    await sleep(60);
  }
  await sleep(5000);   // stale-sweep commits the tail

  const v = C.view();
  const transcript = C.toText();
  console.log('committed lines:', v.committed.length);
  console.log('---');
  v.committed.forEach(l => console.log(`  ${l.speaker}: ${l.text}`));
  console.log('---');

  const body = v.committed.map(l => l.text).join(' ').replace(/\s+/g, ' ');

  // Every sentence must appear, and appear exactly ONCE.
  const counts = SPOKEN.map(s => {
    const needle = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (body.match(new RegExp(needle, 'g')) || []).length;
  });
  const allPresent = counts.every(n => n >= 1);
  const noDupes = counts.every(n => n === 1);

  // A distinctive phrase must not be repeated across lines either.
  const kunCount = (body.match(/My name is Kun/g) || []).length;

  console.log('per-sentence occurrence counts:', JSON.stringify(counts));
  console.log('every sentence captured :', allPresent ? 'PASS' : 'FAIL');
  console.log('no sentence duplicated  :', noDupes ? 'PASS' : 'FAIL');
  console.log('"My name is Kun" x1     :', kunCount === 1 ? 'PASS' : `FAIL (x${kunCount})`);
  console.log('transcript length       :', transcript.length, 'chars');

  const ok = allPresent && noDupes && kunCount === 1;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
