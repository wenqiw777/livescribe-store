#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const runtimeFiles = [
  'popup.html',
  'options.html',
  'src/panel.css',
  'background.js',
];

const runtime = Object.fromEntries(runtimeFiles.map(file => [
  file,
  fs.readFileSync(path.join(root, file), 'utf8').toLowerCase(),
]));

const legacyPurple = [
  '#6d5ae6',
  '#5f4ddb',
  '#5b46d6',
  '#f5f3ff',
  '#e6e1fb',
];

for (const [file, source] of Object.entries(runtime)) {
  for (const color of legacyPurple) {
    assert(!source.includes(color), `${file} still contains legacy purple ${color}`);
  }
}

assert(runtime['popup.html'].includes('#2f6bff'), 'popup primary actions use the icon blue');
assert(runtime['options.html'].includes('#2f6bff'), 'settings primary actions use the icon blue');
assert(runtime['src/panel.css'].includes('--ls-primary: #2f6bff'), 'meeting panel primary token uses the icon blue');
assert(runtime['src/panel.css'].includes('--ls-primary-hover: #1552e8'), 'meeting panel hover token uses the darker brand blue');
assert(runtime['background.js'].includes("color: '#2f6bff'"), 'extension badge uses the icon blue');

console.log('brand theme uses LiveScribe icon blue across extension surfaces');
