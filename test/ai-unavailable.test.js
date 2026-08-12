#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const src = path.join(__dirname, '..', 'src');
const dom = new JSDOM('<!doctype html><body></body>', {
  runScripts: 'outside-only', url: 'https://app.zoom.us/wc/123/start', pretendToBeVisual: true,
});
const w = dom.window;
w.Element.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; }, set(v) { this.textContent = v; },
});
w.chrome = {
  runtime: {
    lastError: null,
    connect: () => ({ postMessage() {} }),
    getURL: p => 'chrome-extension://store-id/' + p,
    sendMessage(msg, cb) {
      const response = msg.type === 'AI_STATUS'
        ? { configured: false, ready: false, reason: 'Choose an AI option in LiveScribe settings.' }
        : { ok: true };
      if (cb) w.setTimeout(() => cb(response), 0);
    },
  },
};
w.navigator.clipboard = { writeText: async () => {} };
w.eval(fs.readFileSync(path.join(src, 'collector.js'), 'utf8'));
w.eval(fs.readFileSync(path.join(src, 'panel.js'), 'utf8'));

(async () => {
  w.LSPanel.mount('Zoom');
  await new Promise(resolve => w.setTimeout(resolve, 30));
  const consent = w.document.querySelector('.ls-consent');
  const yes = consent && [...consent.querySelectorAll('button')].find(b => /this time/i.test(b.textContent));
  if (yes) yes.click();
  await new Promise(resolve => w.setTimeout(resolve, 20));

  const ask = w.document.querySelector('[data-act="ask"]');
  const pause = w.document.querySelector('[data-act="pause"]');
  const end = w.document.querySelector('[data-act="end"]');
  const setup = w.document.querySelector('.ls-ai-setup');
  const checks = [
    ['AI setup guidance is visible', !!setup && /AI|settings/i.test(setup.textContent)],
    ['Ask is disabled', !!ask && ask.disabled],
    ['Pause remains enabled', !!pause && !pause.disabled],
    ['End remains enabled', !!end && !end.disabled],
    ['caption recording still starts', w.LSCollector.isRecording()],
  ];
  for (const [name, ok] of checks) console.log(name.padEnd(42), ok ? 'PASS' : 'FAIL');
  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
