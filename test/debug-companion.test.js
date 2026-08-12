#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
const writes = [];

const elements = Object.fromEntries([
  'backend', 'provider', 'status', 'nativeBox', 'anthropicBox', 'openaiBox',
  'anthropicKey', 'openaiKey', 'anthropicModel', 'openaiModel', 'save',
  'testNative', 'testNativeStatus', 'debugCompanionToggle',
].map(id => [id, { id, value: '', style: {}, append() {} }]));
elements.backend.options = [];
elements.backend.add = option => elements.backend.options.push(option);

const context = {
  document: {
    getElementById(id) { return html.includes(`id="${id}"`) ? elements[id] : null; },
    createElement() { return { value: '', textContent: '' }; },
  },
  setTimeout() {},
  chrome: {
  storage: {
    sync: {
      get(_keys, callback) { callback({}); },
      set(value, callback) { writes.push(value); if (callback) callback(); },
    },
    local: {
      get(_keys, callback) { callback({}); },
      set(_value, callback) { if (callback) callback(); },
    },
  },
  runtime: { lastError: null, sendMessage() {} },
  },
};
vm.runInNewContext(script, context);

const backend = elements.backend;
const toggle = html.includes('id="debugCompanionToggle"') ? elements.debugCompanionToggle : null;
if (toggle && typeof toggle.onclick === 'function') toggle.onclick();

const checks = [
  ['Companion is absent from the public selector', !/option value="native"/.test(html)],
  ['transparent debug target exists', Boolean(toggle)],
  ['debug target is fixed at bottom left', /#debugCompanionToggle\s*\{[^}]*position:\s*fixed[^}]*left:\s*0[^}]*bottom:\s*0/s.test(html)],
  ['debug target is transparent', /#debugCompanionToggle\s*\{[^}]*opacity:\s*0/s.test(html)],
  ['Companion never appears in the dropdown after click', !backend.options.some(option => option.value === 'native')],
  ['public dropdown returns to its placeholder', backend.value === ''],
  ['click persists the Companion backend', writes.some(value => value.backend === 'native')],
  ['click reveals Companion controls', elements.nativeBox.style.display !== 'none'],
];

for (const [name, ok] of checks) console.log(name.padEnd(52), ok ? 'PASS' : 'FAIL');
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
