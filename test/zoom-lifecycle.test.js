#!/usr/bin/env node
// Regression: ending a Zoom web meeting navigates to /wc/home. That shell page
// must not be mistaken for a meeting, otherwise auto-start creates a blank new
// transcript immediately after the real one ends.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'zoom.js'), 'utf8');

function load(pathname) {
  const calls = { mount: 0, captureStart: 0, captureStop: 0, ended: 0, resume: 0 };
  const intervals = [];
  let panelExists = false;

  const documentElement = { addEventListener() {}, dispatchEvent() {} };
  const document = {
    documentElement,
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const window = {
    LSCollector: { update() {}, finalize() {} },
    LSPanel: {
      exists: () => panelExists,
      mount() { calls.mount++; panelExists = true; },
      meetingEnded() { calls.ended++; },
      resumePending() { calls.resume++; },
    },
    LSAutoCapture: {
      create() {
        return {
          start() { calls.captureStart++; },
          stop() { calls.captureStop++; },
          diagnose() { return { locked: false, candidates: [] }; },
        };
      },
    },
    addEventListener() {},
    postMessage() {},
  };
  window.top = window;

  const context = {
    window, document,
    location: { pathname, href: 'https://app.zoom.us' + pathname },
    console: { log() {}, warn() {}, table() {} },
    setTimeout(fn) { fn(); return 1; },
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval() {},
  };
  vm.runInNewContext(source, context, { filename: 'zoom.js' });
  return { calls, context, tick: () => intervals.forEach(fn => fn()) };
}

const hosted = load('/wc/4411471791/start');
const joined = load('/wc/95998112409/join');
const home = load('/wc/home');

// Simulate Zoom routing out of a live meeting without destroying the document.
hosted.tick();
hosted.context.location.pathname = '/wc/home';
hosted.tick();

const checks = [
  ['host view starts capture', hosted.calls.mount === 1 && hosted.calls.captureStart === 1],
  ['join view starts capture', joined.calls.mount === 1 && joined.calls.captureStart === 1],
  ['home does not start capture', home.calls.mount === 0 && home.calls.captureStart === 0],
  ['home still checks pending export', home.calls.resume === 1],
  ['leaving meeting reports end', hosted.calls.ended === 1],
  ['leaving meeting stops capture', hosted.calls.captureStop === 1],
];

for (const [name, ok] of checks) console.log(name.padEnd(34), ok ? 'PASS' : 'FAIL');
const ok = checks.every(([, pass]) => pass);
console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
process.exit(ok ? 0 : 1);
