#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const installer = path.join(root, 'companion', 'macos', 'scripts', 'postinstall');
const build = path.join(root, 'scripts', 'package-companion-macos.sh');
const installerText = fs.existsSync(installer) ? fs.readFileSync(installer, 'utf8') : '';
const buildText = fs.existsSync(build) ? fs.readFileSync(build, 'utf8') : '';
const checks = [
  ['postinstall exists', fs.existsSync(installer)],
  ['package builder exists', fs.existsSync(build)],
  ['Store ID is built in', installerText.includes('gfhncbgjiechicicabgkmlmcljamdelf')],
  ['installer takes no extension ID', !/EXT_ID="\$\{1/.test(installerText)],
  ['Chrome native manifest is installed', /NativeMessagingHosts/.test(installerText)],
  ['signing is supported', /productsign/.test(buildText)],
  ['notarization is supported', /notarytool submit/.test(buildText)],
];
for (const [name, ok] of checks) console.log(name.padEnd(42), ok ? 'PASS' : 'FAIL');
const ok = checks.every(([, pass]) => pass);
console.log(ok ? '\n✅ ALL PASS' : '\n❌ FAILED');
process.exit(ok ? 0 : 1);
