#!/usr/bin/env node
// Live meeting questions use the fast Codex model and a smaller context, while
// end-of-meeting summaries use the higher-quality Terra model.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const nativeCalls = [];
let onMessage = null;
const disk = {};
const dom = new JSDOM('', { runScripts: 'outside-only' });
const w = dom.window;
w.chrome = {
  action: {
    setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
  },
  storage: {
    local: {
      get: async key => key == null ? { ...disk } : { [key]: disk[key] },
      set: async obj => Object.assign(disk, obj),
      remove: async key => { delete disk[key]; },
    },
    sync: { get: async () => ({ backend: 'native', provider: 'claude' }) },
  },
  runtime: {
    lastError: null,
    onConnect: { addListener() {} },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { onMessage = fn; } },
    sendNativeMessage(host, msg, cb) {
      nativeCalls.push({ host, ...msg });
      cb({ summary: 'ok' });
    },
  },
};
w.fetch = async () => ({ ok: false, json: async () => ({}) });
w.eval(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'));

const dispatch = msg => new Promise(resolve => onMessage(msg, {}, resolve));

(async () => {
  await dispatch({ type: 'ASK', question: 'What is the decision?', transcript: 'A'.repeat(20000), highlights: [] });
  await dispatch({ type: 'SUMMARIZE', transcript: 'short transcript', highlights: [] });

  const ask = nativeCalls[0] || {};
  const summary = nativeCalls[1] || {};
  const askTranscript = (ask.prompt || '').split('\nTRANSCRIPT:\n').pop();
  const checks = [
    ['ASK uses Codex', ask.provider === 'codex'],
    ['ASK uses gpt-5.6-luna', ask.model === 'gpt-5.6-luna'],
    ['ASK clips transcript to 16k', askTranscript.length === 16000],
    ['SUMMARY uses Codex', summary.provider === 'codex'],
    ['SUMMARY uses gpt-5.6-terra', summary.model === 'gpt-5.6-terra'],
  ];
  for (const [name, ok] of checks) console.log(name.padEnd(40), ok ? 'PASS' : 'FAIL');
  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
