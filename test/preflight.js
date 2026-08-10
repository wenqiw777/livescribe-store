#!/usr/bin/env node
// Preflight: catch things that make Chrome refuse to load the extension, before
// you hit "Load unpacked".
//
// Chrome validates extension files more strictly than most tools: besides plain
// UTF-8 it also rejects Unicode NONCHARACTERS (U+FFFE/U+FFFF in any plane,
// U+FDD0–U+FDEF) and unpaired surrogates, failing with the misleading message
// "It isn't UTF-8 encoded" — even though editors, git and Python read the file
// fine. Write such a char in a regex character class and the whole extension
// won't load, so this check runs over every shipped text file.
//
// Run: node test/preflight.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'test']);
const TEXT_EXT = new Set(['.js', '.json', '.html', '.css', '.md', '.sh']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (TEXT_EXT.has(path.extname(e.name))) out.push(path.join(dir, e.name));
  }
  return out;
}

const isNoncharacter = cp =>
  (cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE;

let problems = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const buf = fs.readFileSync(file);

  if (buf.slice(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))) {
    console.log(`✗ ${rel}: has a UTF-8 BOM (Chrome may reject)`); problems++;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { console.log(`✗ ${rel}: not valid UTF-8 — ${e.message}`); problems++; continue; }

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isNoncharacter(cp) || (cp >= 0xD800 && cp <= 0xDFFF)) {
      console.log(`✗ ${rel}: contains U+${cp.toString(16).toUpperCase()} ` +
                  `(Unicode noncharacter/surrogate) — Chrome will report "isn't UTF-8 encoded". ` +
                  `Use an escape like \\u${cp.toString(16).toUpperCase()} instead of the literal character.`);
      problems++;
      break;
    }
  }
}

// manifest sanity
const mfPath = path.join(ROOT, 'manifest.json');
try {
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  for (const cs of mf.content_scripts || []) {
    for (const js of cs.js || []) {
      if (!fs.existsSync(path.join(ROOT, js))) { console.log(`✗ manifest references missing file: ${js}`); problems++; }
    }
  }
  for (const f of Object.values(mf.icons || {})) {
    if (!fs.existsSync(path.join(ROOT, f))) console.log(`⚠ icon missing (Chrome still loads, uses default): ${f}`);
  }
} catch (e) { console.log('✗ manifest.json is not valid JSON:', e.message); problems++; }

console.log(problems ? `\n❌ ${problems} problem(s) — Chrome would refuse to load.`
                     : '\n✅ preflight clean — safe to Load unpacked.');
process.exit(problems ? 1 : 0);
