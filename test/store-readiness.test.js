#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const options = fs.readFileSync(path.join(root, 'options.html'), 'utf8');
const optionsJs = fs.readFileSync(path.join(root, 'options.js'), 'utf8');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const forbiddenIdentityText = [
  ['Jackson', 'Wang'].join(' '),
  ['Dylan', 'Pinkins'].join(' '),
  ['wenqi', 'wang'].join(''),
  ['/Users', '/'].join(''),
];
function textFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) textFiles(full, out);
    else if (/\.(?:js|json|html|css|md|sh)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const identityClean = textFiles(root).every(file => {
  const content = fs.readFileSync(file, 'utf8').toLowerCase();
  return forbiddenIdentityText.every(term => !content.includes(term.toLowerCase()));
});

const checks = [
  ['description fits Store limit', [...manifest.description].length <= 132],
  ['description does not claim silence', !/silent/i.test(manifest.description)],
  ['activeTab removed', !manifest.permissions.includes('activeTab')],
  ['scripting removed', !manifest.permissions.includes('scripting')],
  ['unlimitedStorage removed', !manifest.permissions.includes('unlimitedStorage')],
  ['localhost host permission removed', !manifest.host_permissions.some(x => /^http:\/\//.test(x))],
  ['localhost bridge UI removed', !/value="bridge"/.test(options)],
  ['localhost bridge runtime removed', !/backend === 'bridge'/.test(background)],
  ['API key read from local storage', /storage\.local\.get\(\['apiKey'\]/.test(background)],
  ['API key saved to local storage', /storage\.local\.set\(\{ apiKey:/.test(optionsJs)],
  ['API key not saved to sync storage', !/storage\.sync\.set\(\{[^}]*apiKey:/s.test(optionsJs)],
  ['personal names and paths removed', identityClean],
  ['privacy policy exists', fs.existsSync(path.join(root, 'store', 'PRIVACY.md'))],
  ['listing copy exists', fs.existsSync(path.join(root, 'store', 'LISTING.md'))],
  ['review instructions exist', fs.existsSync(path.join(root, 'store', 'REVIEWER_INSTRUCTIONS.md'))],
  ['packaging script exists', fs.existsSync(path.join(root, 'scripts', 'package-store.sh'))],
];

for (const [name, ok] of checks) console.log(name.padEnd(42), ok ? 'PASS' : 'FAIL');
const ok = checks.every(([, pass]) => pass);
console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
process.exit(ok ? 0 : 1);
