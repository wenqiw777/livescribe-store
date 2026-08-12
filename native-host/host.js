#!/usr/bin/env node
'use strict';
// LiveScribe native messaging host.
//
// Chrome launches this on demand and talks to it over stdin/stdout using the
// native-messaging framing: a 4-byte little-endian length prefix followed by a
// UTF-8 JSON message. We receive {prompt}, run `claude -p` (your logged-in
// Claude Code / subscription), and reply {summary} or {error}.
//
// ⚠️ NEVER write anything to stdout except via send() — stray output corrupts
// the length-prefixed frame. Debug goes to stderr only.

const { spawn } = require('child_process');
const CLAUDE = process.env.LS_CLAUDE_BIN || 'claude';
const CODEX = process.env.LS_CODEX_BIN || 'codex';
// Model availability depends on BOTH the CLI version and the account type, and
// the two fail differently: a too-new model reports "requires a newer version of
// Codex", while codex-* models are refused outright for ChatGPT-account logins.
// So try the account default first and walk down — an upgraded CLI then picks up
// the better model with no config change here.
const CODEX_MODELS = (process.env.LS_CODEX_MODEL || '').trim()
  ? [process.env.LS_CODEX_MODEL.trim()]
  : [null, 'gpt-5.5'];   // null = the account default (best available); 'gpt-5.6'
                         // is deliberately absent — it is an API-tier model that
                         // a ChatGPT-account login is always refused.
const MODEL_ERR = /model.*(requires a newer version|is not supported|not found|does not exist)/i;
const TIMEOUT_MS = 180000;

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function log(...a) { process.stderr.write('[livescribe-host] ' + a.join(' ') + '\n'); }

// Both CLIs read the prompt from stdin and print the answer on stdout, so one
// runner covers them. Codex needs --skip-git-repo-check (we are not in a repo)
// and an explicit model for the fixed ASK/SUMMARIZE routes.
function providerCmd(provider, model) {
  if (provider === 'codex') {
    // Live Q&A does not need repo instructions, plugins, hooks, MCP servers, or
    // a persisted Codex session. Skipping those removes most of the cold-start
    // cost while preserving the user's existing Codex login.
    const args = ['exec', '--skip-git-repo-check', '--ephemeral',
      '--ignore-user-config', '--ignore-rules', '-s', 'read-only'];
    if (model) args.push('-m', model);
    args.push('-');
    return { bin: CODEX, args };
  }
  return { bin: CLAUDE, args: ['-p'] };
}

// Codex prints a session banner and a token footer around the answer; keep only
// what sits between them.
function cleanCodex(out) {
  const lines = out.split('\n');
  const start = lines.findIndex(l => l.trim() === '--------');
  let body = start >= 0 ? lines.slice(start + 1) : lines;
  const uidx = body.findIndex(l => l.trim() === 'user');
  if (uidx >= 0) {
    const blank = body.findIndex((l, i) => i > uidx && !l.trim());
    if (blank > 0) body = body.slice(blank + 1);
  }
  const tok = body.findIndex(l => /^tokens used/i.test(l.trim()));
  if (tok >= 0) body = body.slice(0, tok);
  return body.join('\n').trim();
}

function runOnce(prompt, provider, model) {
  return new Promise((resolve) => {
    const { bin, args } = providerCmd(provider, model);
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => { clearTimeout(killer); resolve({ error: 'spawn failed: ' + e.message + ' (' + bin + ')' }); });
    child.on('close', code => {
      clearTimeout(killer);
      const both = out + '\n' + err;
      const apiErr = both.match(/"message":"([^"]{5,300})"/);
      if (apiErr) { resolve({ error: apiErr[1] }); return; }
      const text = provider === 'codex' ? cleanCodex(out) : out.trim();
      if (!text && code !== 0) resolve({ error: `${bin} exited ${code}: ${err.slice(0, 400)}` });
      else resolve({ summary: text });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runModel(prompt, provider, requestedModel) {
  if (provider !== 'codex') return runOnce(prompt, provider, null);
  if (requestedModel) return runOnce(prompt, provider, requestedModel);
  let last = null;
  for (const m of CODEX_MODELS) {
    const res = await runOnce(prompt, provider, m);
    if (!res.error) return res;
    last = res;
    if (!MODEL_ERR.test(res.error)) break;   // a real failure, not a model mismatch
    log('model', m || '(account default)', 'unavailable, trying next');
  }
  return last;
}

// --- read length-prefixed messages from stdin ---
let buf = Buffer.alloc(0);
let busy = Promise.resolve();

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.slice(4, 4 + len);
    buf = buf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { send({ error: 'bad json' }); continue; }
    if (msg && msg.type === 'ping') { send({ ok: true }); continue; }
    // Serialize handling so responses stay ordered.
    busy = busy.then(async () => {
      if (!msg || typeof msg.prompt !== 'string') { send({ error: 'missing prompt' }); return; }
      const provider = msg.provider === 'codex' ? 'codex' : 'claude';
      const model = typeof msg.model === 'string' && /^[A-Za-z0-9._-]+$/.test(msg.model)
        ? msg.model : null;
      log('running', msg.prompt.length, 'chars via', provider, model || '(default model)');
      const res = await runModel(msg.prompt, provider, model);
      send(res);
      log(res.error ? 'ERR ' + res.error : 'ok');
    });
  }
});

process.stdin.on('end', () => { busy.then(() => process.exit(0)); });
process.on('SIGTERM', () => process.exit(0));
