// popup.js — browse saved transcripts, and the surface that still works after
// the browser has been closed.
//
// The in-meeting prompt cannot come back once the meeting tab is gone, so any
// transcript that was never exported is offered here instead, at the top, with
// the same choices: summarize, export .md, export .txt.

const viewEl = document.getElementById('view');
document.getElementById('opts').onclick = () => chrome.runtime.openOptionsPage();

const fmtDate = ts => new Date(ts).toLocaleString();
const fmtDur = (a, b) => {
  const s = Math.max(0, Math.round((b - a) / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};
const stamp = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const send = msg => new Promise(r => chrome.runtime.sendMessage(msg, r));
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---- export builders (shared shape with the in-meeting panel) --------------
function toMarkdown(s) {
  const hs = s.highlights || [];
  let out = `# ${s.title || s.platform}\n\n_${s.platform} · ${fmtDate(s.startedAt)} · ${fmtDur(s.startedAt, s.endedAt || s.startedAt)}_\n\n`;
  if (s.summary) out += `## Summary\n\n${s.summary}\n\n`;
  if (hs.length) out += `## Highlights\n\n${hs.map(x => '- ' + x).join('\n')}\n\n`;
  out += `## Transcript\n\n`;
  out += (s.lines || []).map(l => `**[${stamp(l.t)}] ${l.speaker}:** ${l.text}${l.hl ? '  ⭐' : ''}`).join('\n\n');
  return out + '\n';
}

function toText(s) {
  const hs = s.highlights || [];
  let out = `${s.title || s.platform}\n${s.platform} · ${fmtDate(s.startedAt)} · ${fmtDur(s.startedAt, s.endedAt || s.startedAt)}\n`;
  out += '='.repeat(60) + '\n\n';
  if (s.summary) out += `SUMMARY\n${'-'.repeat(60)}\n${s.summary}\n\n`;
  if (hs.length) out += `HIGHLIGHTS\n${'-'.repeat(60)}\n${hs.map(x => '* ' + x).join('\n')}\n\n`;
  out += `TRANSCRIPT\n${'-'.repeat(60)}\n`;
  out += (s.lines || []).map(l => `[${stamp(l.t)}] ${l.speaker}: ${l.text}${l.hl ? '  *' : ''}`).join('\n');
  return out + '\n';
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function fileBase(s) {
  return (s.title || s.platform || 'transcript').replace(/[^\w一-龥.-]+/g, '_').slice(0, 50) || 'transcript';
}

async function exportSession(s, ext) {
  download(`${fileBase(s)}.${ext}`,
    ext === 'md' ? toMarkdown(s) : toText(s),
    ext === 'md' ? 'text/markdown' : 'text/plain');
  await send({ type: 'SAVE_SESSION', session: { id: s.id, handled: true } });
}

async function summarize(s, into, btn) {
  btn.disabled = true; btn.textContent = 'Summarising…';
  const res = await send({ type: 'SUMMARIZE', transcript: s.transcript, highlights: s.highlights, sessionId: s.id });
  btn.disabled = false; btn.textContent = 'Summarize';
  if (!res) { into.textContent = 'No response.'; return; }
  if (res.error) { into.textContent = '⚠️ ' + res.error; return; }
  s.summary = res.summary;
  into.textContent = res.summary || '(empty)';
}

// ---- views ---------------------------------------------------------------
async function renderList() {
  const [{ sessions = [] }, { sessions: pending = [] }] =
    await Promise.all([send({ type: 'GET_SESSIONS' }), send({ type: 'PENDING' })]);

  if (!sessions.length) {
    viewEl.innerHTML = `<div class="empty">No transcripts yet.<br><br>Join a Google Meet, Zoom web, or Teams meeting and LiveScribe will capture the captions.</div>`;
    return;
  }

  const pendingHtml = pending.length ? `
    <div class="pending">
      <div class="pending-h">${pending.length} transcript${pending.length > 1 ? 's' : ''} not exported yet</div>
      ${pending.map(s => `
        <div class="pending-row" data-pid="${esc(s.id)}">
          <div class="t">${esc(s.title || s.platform)}</div>
          <div class="m">${esc(s.platform)} · ${fmtDate(s.startedAt)} · ${(s.lines || []).length} lines</div>
          <div class="row">
            <button data-act="sum">Summarize</button>
            <button data-act="md">Export .md</button>
            <button data-act="txt">Export .txt</button>
            <button data-act="dismiss">Dismiss</button>
          </div>
          <div class="out"></div>
        </div>`).join('')}
    </div>` : '';

  viewEl.innerHTML = pendingHtml + `<div class="list">${sessions.map(s => `
    <div class="item" data-id="${esc(s.id)}">
      <div class="t">${esc(s.title || s.platform)}</div>
      <div class="m">${esc(s.platform)} · ${fmtDate(s.startedAt)} · ${(s.lines || []).length} lines${s.summary ? ' · ✓ summary' : ''}</div>
    </div>`).join('')}</div>`;

  viewEl.querySelectorAll('.pending-row').forEach(row => {
    const s = pending.find(x => x.id === row.dataset.pid);
    const out = row.querySelector('.out');
    row.querySelectorAll('button').forEach(b => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'sum') return summarize(s, out, b);
        if (act === 'md') await exportSession(s, 'md');
        else if (act === 'txt') await exportSession(s, 'txt');
        else await send({ type: 'SAVE_SESSION', session: { id: s.id, handled: true } });
        renderList();
      };
    });
  });

  viewEl.querySelectorAll('.item').forEach(it =>
    it.onclick = () => renderDetail(sessions.find(s => s.id === it.dataset.id)));
}

function renderDetail(s) {
  viewEl.innerHTML = `<div class="detail">
    <span class="back">← All transcripts</span>
    <h2>${esc(s.title || s.platform)}</h2>
    <div class="meta">${esc(s.platform)} · ${fmtDate(s.startedAt)} · ${fmtDur(s.startedAt, s.endedAt || s.startedAt)} · ${(s.lines || []).length} lines</div>
    <div class="box" id="sum">${s.summary ? esc(s.summary) : '<span style="color:#999">No summary yet.</span>'}</div>
    <div class="row">
      <button id="dosum">Summarize</button>
      <button class="primary" id="md">Export .md</button>
      <button id="txt">Export .txt</button>
    </div>
    <div class="row">
      <button id="cp">Copy</button>
      <button class="danger" id="del">Delete</button>
    </div>
    <div class="meta" style="margin-top:12px">Transcript</div>
    <div class="box">${esc(s.transcript || '')}</div>
  </div>`;
  const out = viewEl.querySelector('#sum');
  viewEl.querySelector('.back').onclick = renderList;
  viewEl.querySelector('#dosum').onclick = (e) => summarize(s, out, e.target);
  viewEl.querySelector('#md').onclick = () => exportSession(s, 'md');
  viewEl.querySelector('#txt').onclick = () => exportSession(s, 'txt');
  viewEl.querySelector('#cp').onclick = () => navigator.clipboard.writeText(toMarkdown(s));
  viewEl.querySelector('#del').onclick = async () => { await send({ type: 'DELETE_SESSION', id: s.id }); renderList(); };
}

renderList();
