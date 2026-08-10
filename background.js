// background.js — service worker. Stores sessions locally. AI requests go
// either to the user's on-device native companion or, when explicitly selected,
// to api.anthropic.com with the user's own API key.

const MAX_SESSIONS = 50;

// STORAGE SHAPE — one record per transcript line, not one blob per session.
//
// Writing the whole session on a timer means the cost of saving grows with the
// meeting, so it can only be done rarely, and anything spoken since the last
// write is lost if the tab dies. Keyed per line, a save is a constant-size write
// and can happen the moment a line is finalised — nothing finalised is ever lost.
// The in-progress line is mirrored to its own key so even a half-spoken sentence
// survives.
//
//   ls:m:<sid>       session metadata
//   ls:l:<sid>:<n>   line n
//   ls:p:<sid>       the line currently being spoken
const K = {
  meta: sid => `ls:m:${sid}`,
  line: (sid, n) => `ls:l:${sid}:${n}`,
  pend: sid => `ls:p:${sid}`,
};

async function saveMeta(meta) {
  if (!meta || !meta.id) return;
  const key = K.meta(meta.id);
  const cur = (await chrome.storage.local.get(key))[key] || {};
  await chrome.storage.local.set({ [key]: { ...cur, ...meta } });
}

async function appendLines(sid, lines, from) {
  if (!sid || !lines || !lines.length) return;
  const obj = {};
  lines.forEach((l, i) => { obj[K.line(sid, from + i)] = l; });
  await chrome.storage.local.set(obj);
}

async function setPending(sid, line) {
  if (!sid) return;
  if (line) await chrome.storage.local.set({ [K.pend(sid)]: line });
  else await chrome.storage.local.remove(K.pend(sid));
}

// Rebuild whole sessions from their parts.
async function getSessions() {
  const all = await chrome.storage.local.get(null);
  const byId = new Map();
  for (const [k, v] of Object.entries(all)) {
    const m = /^ls:(m|l|p):([^:]+)(?::(\d+))?$/.exec(k);
    if (!m) continue;
    const [, kind, sid, idx] = m;
    if (!byId.has(sid)) byId.set(sid, { id: sid, lines: [], _pending: null });
    const rec = byId.get(sid);
    if (kind === 'm') Object.assign(rec, v);
    else if (kind === 'l') rec.lines[Number(idx)] = v;
    else rec._pending = v;
  }
  const out = [];
  for (const rec of byId.values()) {
    rec.lines = rec.lines.filter(Boolean);
    // A line still being spoken when the tab died is real transcript too.
    if (rec._pending && rec._pending.text) rec.lines.push(rec._pending);
    delete rec._pending;
    rec.transcript = rec.lines.map(l => `${l.speaker}: ${l.text}`).join('\n');
    if (rec.lines.length || rec.startedAt) out.push(rec);
  }
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return out;
}

async function deleteSession(sid) {
  const all = await chrome.storage.local.get(null);
  const kill = Object.keys(all).filter(k => k.startsWith(`ls:m:${sid}`) ||
    k.startsWith(`ls:l:${sid}:`) || k === `ls:p:${sid}`);
  if (kill.length) await chrome.storage.local.remove(kill);
}

// Keep storage from growing without bound.
async function prune() {
  const sessions = await getSessions();
  for (const s of sessions.slice(MAX_SESSIONS)) await deleteSession(s.id);
}

async function patchSession(id, patch) { await saveMeta({ id, ...patch }); }

// A transcript nobody knows about is as good as lost. Closing the browser is
// fine for the data — storage.local survives a restart — but the in-meeting
// prompt cannot reappear, because the meeting tab is gone. The toolbar badge is
// the surface that still works: it says how many transcripts are waiting.
async function pendingSessions() {
  return (await getSessions()).filter(s => !s.handled && (s.lines || []).length);
}

async function updateBadge() {
  try {
    const n = (await pendingSessions()).length;
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6d5ae6' });
    await chrome.action.setTitle({
      title: n ? `LiveScribe — ${n} transcript${n > 1 ? 's' : ''} not exported yet`
                : 'LiveScribe transcripts',
    });
  } catch (e) { /* action API unavailable */ }
}

// A long-lived port from the meeting tab. The tab closing, navigating, or
// crashing all sever it, and the service worker — which outlives the tab — is
// told. That is the only end-of-meeting signal that survives the tab dying;
// anything polled inside the page cannot run at the moment it matters.
const PORT_NAME = 'ls_meeting_tab';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  let sid = null;
  port.onMessage.addListener((m) => { if (m && m.sessionId) sid = m.sessionId; });
  port.onDisconnect.addListener(async () => {
    void chrome.runtime.lastError;
    if (!sid) return;
    await saveMeta({ id: sid, ended: true, endedAt: Date.now() });
    updateBadge();
  });
});

chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);

const NATIVE_HOST = 'com.livescribe.summarizer';
const ASK_MODEL = 'gpt-5.6-luna';
const SUMMARY_MODEL = 'gpt-5.6-terra';
const ASK_CONTEXT_CHARS = 16000;

// Run a prompt through the native messaging host and the selected CLI/model.
function callNative(prompt, provider, model) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { prompt, provider, model }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ error: 'Native host not reachable: ' + chrome.runtime.lastError.message +
            '. Run native-host/install.sh with your extension id, then reload.' });
          return;
        }
        if (!resp) { resolve({ error: 'Empty response from native host.' }); return; }
        if (resp.error) { resolve({ error: 'Native host: ' + resp.error }); return; }
        resolve({ summary: resp.summary });
      });
    } catch (e) {
      resolve({ error: 'sendNativeMessage failed: ' + e.message });
    }
  });
}

const SUMMARY_PROMPT = `You are a meeting-notes assistant. Below is a raw, imperfect live-caption transcript of a meeting (speaker labels may be wrong or generic). Produce concise notes in the SAME language as the transcript.

Use this markdown structure:
## 概要 / Summary
(2-4 sentences)

## 关键决定 / Key decisions
- ...

## 待办 / Action items
- [owner if identifiable] task

## 重要引述 / Notable quotes
- "..." — speaker (only if clearly meaningful)

Be faithful to the transcript; do not invent decisions or tasks. If a section has nothing, write "—".

TRANSCRIPT:
`;

async function summarize(transcript, highlights) {
  const clipped = transcript.length > 60000 ? transcript.slice(-60000) : transcript;
  const marked = highlights && highlights.length
    ? `\n\nThe user marked these moments as important — make sure the notes reflect them:\n${highlights.map(h => '- ' + h).join('\n')}` : '';
  return runPrompt(SUMMARY_PROMPT + clipped + marked, {
    provider: 'codex', model: SUMMARY_MODEL,
  });
}

// Runs an arbitrary prompt through whichever backend is configured.
async function runPrompt(prompt, override = {}) {
  const cfg = await chrome.storage.sync.get(['model', 'backend', 'provider']);
  const { apiKey } = await chrome.storage.local.get(['apiKey']);
  // Default to native messaging unless an API key is set with no explicit choice.
  const backend = cfg.backend || (cfg.apiKey ? 'api' : 'native');
  const provider = override.provider || (cfg.provider === 'codex' ? 'codex' : 'claude');
  const requestedModel = override.model || null;

  if (backend === 'native') {
    return await callNative(prompt, provider, requestedModel);
  }

  // The Anthropic API backend cannot run a Codex model. Fixed Codex routes use
  // the installed native host and the user's existing Codex subscription.
  if (provider === 'codex') return await callNative(prompt, provider, requestedModel);

  // --- Anthropic API path ---
  const { model = 'claude-sonnet-5' } = cfg;
  if (!apiKey) return { error: 'No Claude API key set. Open LiveScribe settings and paste your key, or use the local AI companion.' };
  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    return { error: 'Network error calling Claude API: ' + e.message };
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch (e) {}
    return { error: `Claude API ${resp.status}. ${detail}` };
  }
  const data = await resp.json();
  const summary = (data.content || []).map(b => b.text || '').join('').trim();
  return { summary };
}

// Ask a question about the meeting while it is still running.
function askPrompt(question, transcript, highlights) {
  const clipped = transcript.length > ASK_CONTEXT_CHARS ? transcript.slice(-ASK_CONTEXT_CHARS) : transcript;
  return `You are helping someone during a live meeting. Answer their question using ONLY the transcript below.
Answer in the SAME language as the transcript. Be brief and concrete — short paragraphs or bullets, no preamble.
If the transcript does not contain the answer, say so plainly rather than guessing.
` +
    (highlights && highlights.length
      ? `\nThe user marked these moments as important:\n${highlights.map(h => '- ' + h).join('\n')}\n` : '') +
    `\nQUESTION: ${question}\n\nTRANSCRIPT:\n${clipped}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'ASK') {
        if (!msg.transcript || !msg.transcript.trim()) {
          sendResponse({ error: 'Nothing transcribed yet — start speaking in the meeting first.' });
          return;
        }
        sendResponse(await runPrompt(askPrompt(msg.question, msg.transcript, msg.highlights), {
          provider: 'codex', model: ASK_MODEL,
        }));
      }
      else if (msg.type === 'SAVE_SESSION') {
        const { lines, transcript, ...meta } = msg.session || {};
        await saveMeta(meta);
        sendResponse({ ok: true });
        updateBadge();
      }
      else if (msg.type === 'APPEND_LINES') {
        await appendLines(msg.sessionId, msg.lines, msg.from);
        sendResponse({ ok: true });
        if (msg.from === 0) updateBadge();     // first line of a new session
      }
      else if (msg.type === 'SET_PENDING') {
        await setPending(msg.sessionId, msg.line);
        sendResponse({ ok: true });
      }
      else if (msg.type === 'SUMMARIZE') {
        const res = await summarize(msg.transcript, msg.highlights);
        if (res.summary && msg.sessionId) await patchSession(msg.sessionId, { summary: res.summary });
        sendResponse(res);
      }
      else if (msg.type === 'GET_SESSIONS') { sendResponse({ sessions: await getSessions() }); }
      else if (msg.type === 'DELETE_SESSION') { await deleteSession(msg.id); sendResponse({ ok: true }); updateBadge(); }
      else if (msg.type === 'PENDING') { sendResponse({ sessions: await pendingSessions() }); }
      else if (msg.type === 'PRUNE') { await prune(); sendResponse({ ok: true }); }
      else sendResponse({ error: 'unknown message' });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();
  return true; // async response
});
