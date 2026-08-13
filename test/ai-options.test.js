#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const options = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');

async function runBackend(backend) {
  const fetches = [];
  const nativeCalls = [];
  let onMessage;
  const local = {
    anthropicApiKey: 'sk-ant-test-only',
    openaiApiKey: 'sk-openai-test-only',
  };
  const sync = { backend, anthropicModel: 'claude-test', openaiModel: 'gpt-test', provider: 'codex' };
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  const w = dom.window;
  w.chrome = {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    storage: {
      local: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, local[k]])),
        set: async obj => Object.assign(local, obj), remove: async () => {},
      },
      sync: { get: async () => ({ ...sync }) },
    },
    runtime: {
      lastError: null,
      onConnect: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { onMessage = fn; } },
      sendNativeMessage(host, msg, cb) { nativeCalls.push({ host, msg }); cb({ summary: 'native' }); },
    },
  };
  w.fetch = async (url, init) => {
    fetches.push({ url, init });
    if (String(url).includes('openai.com')) {
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'openai' }] }] }) };
    }
    return { ok: true, json: async () => ({ content: [{ text: 'anthropic' }] }) };
  };
  w.eval(backgroundSource);
  const dispatch = msg => new Promise(resolve => onMessage(msg, {}, resolve));
  const result = await dispatch({ type: 'ASK', question: 'Decision?', transcript: 'Alex: Ship Friday', highlights: [] });
  return { fetches, nativeCalls, result };
}

(async () => {
  const anthropic = await runBackend('anthropic');
  const openai = await runBackend('openai');
  const checks = [
    ['version is 0.1.2', manifest.version === '0.1.2'],
    ['first option is an AI placeholder', /<option value=""[^>]*selected[^>]*>Choose how to use AI<\/option>/.test(options)],
    ['Anthropic choice is present', /Use my Anthropic API key/.test(options)],
    ['OpenAI choice is present', /Use my OpenAI API key/.test(options)],
    ['OpenAI model uses a dropdown', /<select id="openaiModel">/.test(options) && !/<input id="openaiModel"/.test(options)],
    ['OpenAI dropdown offers Luna', /option value="gpt-5\.6-luna"/.test(options)],
    ['OpenAI dropdown offers Terra', /option value="gpt-5\.6-terra"/.test(options)],
    ['OpenAI dropdown offers Sol', /option value="gpt-5\.6-sol"/.test(options)],
    ['OpenAI dropdown defaults to Luna', /option value="gpt-5\.6-luna"[^>]*selected/.test(options)],
    ['OpenAI dropdown offers earlier models', [
      'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
      'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
    ].every(model => options.includes(`option value="${model}"`))],
    ['Companion choice is hidden from public selector', !/option value="native"/.test(options)],
    ['Companion download is hidden from public settings', !/id="downloadCompanion"/.test(options)],
    ['OpenAI host permission is present', manifest.host_permissions.includes('https://api.openai.com/*')],
    ['Anthropic ASK calls Anthropic', anthropic.fetches.length === 1 && /anthropic\.com/.test(anthropic.fetches[0].url)],
    ['Anthropic ASK avoids native host', anthropic.nativeCalls.length === 0],
    ['OpenAI ASK calls OpenAI', openai.fetches.length === 1 && /openai\.com/.test(openai.fetches[0].url)],
    ['OpenAI ASK avoids native host', openai.nativeCalls.length === 0],
    ['OpenAI response is parsed', openai.result.summary === 'openai'],
  ];
  for (const [name, ok] of checks) console.log(name.padEnd(44), ok ? 'PASS' : 'FAIL');
  const ok = checks.every(([, pass]) => pass);
  console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})();
