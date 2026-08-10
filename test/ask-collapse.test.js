#!/usr/bin/env node
// A completed live answer becomes a compact preview and can be expanded by
// clicking it. This keeps long answers from taking over the meeting panel.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', {
  runScripts: 'outside-only', url: 'https://app.zoom.us/wc/123/start', pretendToBeVisual: true,
});
const w = dom.window;
w.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; }, set(v) { this.textContent = v; },
});
w.chrome = {
  storage: { sync: { get: (keys, cb) => cb({ autoStart: true }) } },
  runtime: {
    lastError: null,
    connect: () => ({ postMessage() {} }),
    sendMessage(msg, cb) {
      const res = msg.type === 'ASK'
        ? { summary: 'One long answer. Two long answer. Three long answer. Four long answer. Five long answer.' }
        : { ok: true };
      if (cb) w.setTimeout(() => cb(res), 0);
    },
  },
};
w.navigator.clipboard = { writeText: async () => {} };
w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'collector.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'panel.js'), 'utf8'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  w.LSPanel.mount('Zoom');
  await sleep(20);
  [...w.document.querySelectorAll('.ls-consent button')]
    .find(b => /this time/i.test(b.textContent)).click();
  w.LSCollector.update('a', 'Alex Johnson', 'We will launch Friday');
  w.LSCollector.finalize('a');
  await sleep(20);

  const input = w.document.querySelector('.ls-input');
  input.value = 'When do we launch?';
  w.document.querySelector('[data-act="ask"]').click();
  await sleep(30);

  const answer = w.document.querySelector('.ls-answer');
  const ask = w.document.querySelector('.ls-ask');
  const compact = answer.classList.contains('ls-compact') && !answer.classList.contains('ls-expanded');
  const chipsHiddenState = ask.classList.contains('ls-answered');
  answer.click();
  const expanded = answer.classList.contains('ls-expanded');

  console.log('answer compact after response :', compact ? 'PASS' : 'FAIL');
  console.log('question chips compacted      :', chipsHiddenState ? 'PASS' : 'FAIL');
  console.log('click expands answer          :', expanded ? 'PASS' : 'FAIL');
  const ok = compact && chipsHiddenState && expanded;
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
