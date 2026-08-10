// panel.js — the in-meeting widget.
//
// Interaction model follows Tactiq's:
//   * ASK FIRST. A meeting isn't transcribed until you say so for that meeting,
//     because silently recording every call you join is the wrong
//     default.
//   * AUTOSAVE. The transcript is persisted on a timer, not only when you press
//     an end button — closing the tab mid-meeting must not lose the notes.
//   * HIGHLIGHT. Click any line to mark it; marked lines are handed to the model
//     as the parts that mattered.
//   * ASK DURING, not just after. Quick prompts plus a free-text box answer
//     questions about what has been said so far, mid-meeting.

(function () {
  if (window.LSPanel) return;
  const C = window.LSCollector;
  if (!C) return;

  const QUICK = [
    'What are the key points so far?',
    'List action items',
    'Suggest 3 follow-up questions',
  ];

  let el, bodyEl, timeEl, askWrap, answerEl;
  let platform = 'meeting';
  let autoScroll = true;
  let started = false;          // user consented for this meeting
  let ended = false;
  let sessionId = null;
  // Persistence is incremental now: a line is written the moment it is
  // finalised, so there is no window in which finished speech is unsaved.
  let savedCount = 0;      // committed lines already written
  let savedLastText = '';  // the collector may still extend the last line
  let pendingText = '';
  // Elapsed time must exclude paused stretches, so it is accumulated rather
  // than derived from the session start.
  let elapsedMs = 0, runningSince = null;
  let pill = null;                 // restore button shown while the panel is hidden
  let port = null;                 // severed when this tab goes away — see background.js

  const h = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const fmtElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  function sessionDurationMs(sess) {
    const startedAt = Number(sess && sess.startedAt);
    const endedAt = Number(sess && sess.endedAt);
    let duration = Number.isFinite(startedAt) && Number.isFinite(endedAt)
      ? Math.max(0, endedAt - startedAt) : 0;
    for (const line of (sess && sess.lines) || []) {
      if (Number.isFinite(line.t)) duration = Math.max(duration, line.t);
    }
    return duration;
  }

  // ---- shell ---------------------------------------------------------------
  function build() {
    el = h('div');
    el.id = 'ls-panel';
    el.innerHTML = `
      <div class="ls-head">
        <span class="ls-dot"></span>
        <span class="ls-title">LiveScribe</span>
        <span class="ls-time">00:00</span>
        <button class="ls-iconbtn" data-act="min" title="Minimise">–</button>
        <button class="ls-iconbtn" data-act="close" title="Hide">✕</button>
      </div>
      <div class="ls-body"></div>
      <div class="ls-ask">
        <div class="ls-quick"></div>
        <div class="ls-askrow">
          <input class="ls-input" name="livescribe-question" placeholder="Ask me anything…" />
          <button class="ls-btn ls-primary ls-send" data-act="ask">Ask</button>
        </div>
        <div class="ls-answer" hidden></div>
      </div>
      <div class="ls-foot">
        <button class="ls-btn" data-act="pause">Pause</button>
        <button class="ls-btn" data-act="copy">Copy</button>
        <button class="ls-btn ls-danger" data-act="end">End</button>
      </div>
      <div class="ls-toast"></div>`;
    document.documentElement.appendChild(el);

    bodyEl = el.querySelector('.ls-body');
    timeEl = el.querySelector('.ls-time');
    askWrap = el.querySelector('.ls-ask');
    answerEl = el.querySelector('.ls-answer');

    const quick = el.querySelector('.ls-quick');
    QUICK.forEach(q => {
      const b = h('button', 'ls-chip', q);
      b.addEventListener('click', () => ask(q));
      quick.appendChild(b);
    });
    el.querySelector('.ls-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ask(e.target.value); }
      e.stopPropagation();   // don't let the meeting's hotkeys eat typing
    });
    answerEl.setAttribute('role', 'button');
    answerEl.tabIndex = 0;
    const toggleAnswer = () => {
      if (!answerEl.classList.contains('ls-compact')) return;
      const expanded = answerEl.classList.toggle('ls-expanded');
      answerEl.title = expanded ? 'Click to collapse' : 'Click to expand';
    };
    answerEl.addEventListener('click', toggleAnswer);
    answerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAnswer(); }
    });

    el.addEventListener('click', onClick);
    bodyEl.addEventListener('scroll', () => {
      autoScroll = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
    });
    makeDraggable(el, el.querySelector('.ls-head'));
    setInterval(onTick, 1000);
    if (started) { el.classList.remove('ls-gate'); render(C.view()); }
    else renderConsent();
  }

  function elapsed() {
    return elapsedMs + (runningSince ? Date.now() - runningSince : 0);
  }

  function onTick() {
    if (!started) return;
    timeEl.textContent = fmtElapsed(elapsed());
    if (pill) pill.querySelector('.ls-pill-t').textContent = fmtElapsed(elapsed());
  }

  // ---- consent gate --------------------------------------------------------
  function renderConsent() {
    el.classList.add('ls-gate');
    bodyEl.innerHTML = '';
    const box = h('div', 'ls-consent');
    box.appendChild(h('strong', null, 'Transcribe this meeting?'));
    box.appendChild(h('p', 'ls-sub', 'LiveScribe reads the captions this meeting already produces. No bot joins and no audio is recorded.'));
    const cc = h('label', 'ls-check');
    const box2 = document.createElement('input');
    box2.type = 'checkbox'; box2.className = 'ls-cc-opt'; box2.name = 'livescribe-enable-captions';
    cc.appendChild(box2);
    cc.appendChild(h('span', null, "Turn on the meeting's live transcription for me"));
    box.appendChild(cc);
    // Stated plainly: this one step is not silent, unlike everything else here.
    box.appendChild(h('p', 'ls-warn', 'Zoom tells every participant when live transcription is switched on.'));
    const row = h('div', 'ls-consentrow');
    const once = h('button', 'ls-btn ls-primary', 'Yes, this time');
    const no = h('button', 'ls-btn', 'No');
    const wantCC = () => !!el.querySelector('.ls-cc-opt') && el.querySelector('.ls-cc-opt').checked;
    once.addEventListener('click', () => beginSession(wantCC()));
    no.addEventListener('click', () => el.remove());
    row.append(once, no);
    box.appendChild(row);
    bodyEl.appendChild(box);
  }

  function beginSession(enableCC) {
    started = true;
    if (enableCC) requestCaptions();
    el.classList.remove('ls-gate');
    C.reset();
    sessionId = 'ls_' + C.startedAt();
    C.setRecording(true);
    elapsedMs = 0;
    runningSince = Date.now();
    savedCount = 0; savedLastText = ''; pendingText = '';
    // Held open for the life of the meeting. Closing this tab breaks it, and the
    // service worker marks the session ended on our behalf.
    try {
      port = chrome.runtime.connect({ name: 'ls_meeting_tab' });
      port.postMessage({ sessionId });
    } catch (e) { /* extension reloading */ }
    send({ type: 'SAVE_SESSION', session: {
      id: sessionId, platform, title: (document.title || platform).slice(0, 120),
      url: location.href, startedAt: C.startedAt(),
    } });
    renderEmpty();
    toast('Transcribing');
  }

  function renderEmpty() {
    bodyEl.innerHTML = '';
    const e = h('div', 'ls-empty');
    e.appendChild(h('strong', null, 'Listening…'));
    e.appendChild(document.createTextNode('Start talking during the meeting to see the transcript here.'));
    bodyEl.appendChild(e);
  }

  // ---- autosave ------------------------------------------------------------
  function snapshot() {
    return {
      id: sessionId,
      platform,
      title: (document.title || platform).slice(0, 120),
      url: location.href,
      startedAt: C.startedAt(),
      endedAt: Date.now(),
      lines: C.view().committed,
      transcript: C.toText(),
      highlights: C.highlights(),
      // `ended` / `handled` are deliberately NOT set here: autosave writes this
      // object every 30s and would otherwise reset flags it does not own.
    };
  }

  function persist(v) {
    if (!started || !sessionId) return;
    const committed = v.committed;

    // The collector appends to the last line while a speaker keeps talking, so
    // that line has to be rewritten in place rather than only appended once.
    if (savedCount > 0 && committed.length >= savedCount) {
      const lastSaved = committed[savedCount - 1];
      if (lastSaved && lastSaved.text !== savedLastText) {
        send({ type: 'APPEND_LINES', sessionId, from: savedCount - 1, lines: [lastSaved] });
        savedLastText = lastSaved.text;
      }
    }
    if (committed.length > savedCount) {
      const fresh = committed.slice(savedCount);
      send({ type: 'APPEND_LINES', sessionId, from: savedCount, lines: fresh });
      savedCount = committed.length;
      savedLastText = committed[savedCount - 1].text;
    }

    // Mirror the half-spoken line too, so even that survives a crash.
    const live = v.active[0] || null;
    const text = live ? live.text : '';
    if (text !== pendingText) {
      pendingText = text;
      send({ type: 'SET_PENDING', sessionId, line: live ? { speaker: live.speaker, text } : null });
    }
  }

  function send(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (e) {}
  }

  // ---- transcript ----------------------------------------------------------
  function render(v) {
    persist(v);
    if (!started || el.classList.contains('ls-summary-open')) return;
    if (!v.committed.length && !v.active.length) { renderEmpty(); return; }

    // Group consecutive lines from one speaker into a turn, so a long stretch of
    // speech reads as a paragraph instead of repeating the name every line.
    const frag = document.createDocumentFragment();
    let turn = null, lastSpeaker = null;

    v.committed.forEach((l, i) => {
      if (l.speaker !== lastSpeaker) {
        turn = h('div', 'ls-turn');
        const who = h('div', 'ls-who');
        who.appendChild(h('span', 'ls-name', l.speaker));
        if (typeof l.t === 'number') who.appendChild(h('span', 'ls-at', fmtElapsed(l.t)));
        turn.appendChild(who);
        frag.appendChild(turn);
        lastSpeaker = l.speaker;
      }
      const p = h('div', 'ls-text' + (l.hl ? ' ls-hl' : ''), l.text);
      p.title = 'Click to highlight';
      p.addEventListener('click', () => {
        const on = C.toggleHighlight(i);
        toast(on ? 'Highlighted' : 'Highlight removed');
      });
      turn.appendChild(p);
    });

    for (const l of v.active) {
      if (l.speaker !== lastSpeaker) {
        turn = h('div', 'ls-turn');
        const who = h('div', 'ls-who');
        who.appendChild(h('span', 'ls-name', l.speaker));
        turn.appendChild(who);
        frag.appendChild(turn);
        lastSpeaker = l.speaker;
      }
      turn.appendChild(h('div', 'ls-text ls-live-text', l.text));
    }

    bodyEl.innerHTML = '';
    bodyEl.appendChild(frag);
    if (autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ---- ask -----------------------------------------------------------------
  function ask(question) {
    question = (question || '').trim();
    if (!question) return;
    if (!C.lineCount()) { toast('Nothing transcribed yet'); return; }
    answerEl.hidden = false;
    answerEl.textContent = 'Thinking…';
    answerEl.classList.remove('ls-compact', 'ls-expanded');
    answerEl.removeAttribute('title');
    askWrap.classList.remove('ls-answered');
    askWrap.classList.add('ls-busy');
    try {
      chrome.runtime.sendMessage(
        { type: 'ASK', question, transcript: C.toText(), highlights: C.highlights() },
        (res) => {
          askWrap.classList.remove('ls-busy');
          if (chrome.runtime.lastError) { answerEl.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
          if (!res) { answerEl.textContent = 'No response.'; return; }
          if (res.error) { answerEl.textContent = '⚠️ ' + res.error; return; }
          answerEl.textContent = res.summary || '(empty)';
          answerEl.classList.add('ls-compact');
          answerEl.title = 'Click to expand';
          askWrap.classList.add('ls-answered');
        });
    } catch (e) {
      askWrap.classList.remove('ls-busy');
      answerEl.textContent = 'Error: ' + e.message;
    }
  }

  function requestCaptions() {
    if (typeof window.LSRequestCaptions !== 'function') { toast('Not supported here'); return; }
    window.LSRequestCaptions();
    toast('Asked Zoom to start transcription');
  }

  // Dismissing the panel must not end the meeting's transcript — capture keeps
  // running and a small button brings it back. Destroying the node instead left
  // no way to return, and recording could not be resumed.
  function hidePanel() {
    el.style.display = 'none';
    if (pill) return;
    pill = h('div', 'ls-pill');
    pill.title = 'Show LiveScribe';
    pill.appendChild(h('span', 'ls-dot'));
    pill.appendChild(h('span', 'ls-pill-t', started ? fmtElapsed(elapsed()) : 'LiveScribe'));
    pill.addEventListener('click', showPanel);
    document.documentElement.appendChild(pill);
  }

  function showPanel() {
    el.style.display = '';
    if (pill) { pill.remove(); pill = null; }
  }

  // ---- controls ------------------------------------------------------------
  function onClick(e) {
    const act = e.target.getAttribute && e.target.getAttribute('data-act');
    if (!act) return;
    if (act === 'min') el.classList.toggle('ls-min');
    else if (act === 'close') hidePanel();
    else if (act === 'ask') ask(el.querySelector('.ls-input').value);
    else if (act === 'pause') {
      const on = !C.isRecording();
      C.setRecording(on);
      if (on) { runningSince = Date.now(); }
      else if (runningSince) { elapsedMs += Date.now() - runningSince; runningSince = null; }
      el.classList.toggle('ls-paused', !on);
      e.target.textContent = on ? 'Pause' : 'Resume';
      toast(on ? 'Transcribing' : 'Paused — click again to resume');
    } else if (act === 'copy') {
      navigator.clipboard.writeText(C.toText()).then(() => toast('Transcript copied'));
    } else if (act === 'end') {
      finishRecording('Recording ended — save your transcript?', 'user');
    }
  }

  // ---- export --------------------------------------------------------------
  function stamp(ms) { return fmtElapsed(ms); }

  function buildMarkdown(sess, sum) {
    const v = { committed: sess.lines || [] };
    const hs = sess.highlights || [];
    const when = new Date(sess.startedAt).toLocaleString();
    const dur = fmtElapsed(sessionDurationMs(sess));
    let out = `# ${sess.title || sess.platform}\n\n_${sess.platform} · ${when} · ${dur}_\n\n`;
    if (sum) out += `## Summary\n\n${sum}\n\n`;
    if (hs.length) out += `## Highlights\n\n${hs.map(x => '- ' + x).join('\n')}\n\n`;
    out += `## Transcript\n\n`;
    out += v.committed.map(l =>
      `**[${stamp(l.t || 0)}] ${l.speaker}:** ${l.text}${l.hl ? '  ⭐' : ''}`).join('\n\n');
    return out + '\n';
  }

  function buildText(sess, sum) {
    const v = { committed: sess.lines || [] };
    const hs = sess.highlights || [];
    const when = new Date(sess.startedAt).toLocaleString();
    const dur = fmtElapsed(sessionDurationMs(sess));
    let out = `${sess.title || sess.platform}\n${sess.platform} · ${when} · ${dur}\n`;
    out += '='.repeat(60) + '\n\n';
    if (sum) out += `SUMMARY\n${'-'.repeat(60)}\n${sum}\n\n`;
    if (hs.length) out += `HIGHLIGHTS\n${'-'.repeat(60)}\n${hs.map(x => '* ' + x).join('\n')}\n\n`;
    out += `TRANSCRIPT\n${'-'.repeat(60)}\n`;
    out += v.committed.map(l =>
      `[${stamp(l.t || 0)}] ${l.speaker}: ${l.text}${l.hl ? '  *' : ''}`).join('\n');
    return out + '\n';
  }

  function download(ext, text, title) {
    const base = (title || platform).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 50) || 'transcript';
    const blob = new Blob([text], { type: ext === 'md' ? 'text/markdown' : 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${base}.${ext}`;
    document.documentElement.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Saved .${ext}`);
  }

  let lastSummary = null;

  function markHandled(id) {
    if (!id) return;
    try { chrome.runtime.sendMessage({ type: 'SAVE_SESSION', session: { id, handled: true } },
      () => void chrome.runtime.lastError); } catch (e) {}
  }

  // The end-of-meeting prompt. `sess` may be the live session or one restored
  // from storage after the meeting page navigated away — the meeting platform
  // tears this tab down when the call ends, so the prompt often has to be shown
  // on the page that replaces it rather than in the meeting itself.
  function showExport(ended, sess, heading) {
    const live = !sess;
    sess = sess || snapshot();
    if (!(sess.lines || []).length && !ended) { toast('Nothing transcribed yet'); return; }

    if (live) {
      C.setRecording(false);
      if (runningSince) { elapsedMs += Date.now() - runningSince; runningSince = null; }
        try { chrome.runtime.sendMessage({ type: 'SAVE_SESSION', session: sess }, () => void chrome.runtime.lastError); } catch (e) {}
    }
    el.classList.add('ls-paused', 'ls-summary-open');
    el.classList.remove('ls-gate');
    showPanel();
    lastSummary = sess.summary || null;

    const nLines = (sess.lines || []).length;
    const dur = fmtElapsed(sessionDurationMs(sess));
    timeEl.textContent = dur;

    bodyEl.innerHTML = '';
    const box = h('div', 'ls-export');
    box.appendChild(h('strong', null, heading || (ended ? 'Meeting ended — save your transcript?' : 'Export transcript')));
    box.appendChild(h('p', 'ls-sub', `${sess.title || sess.platform} · ${nLines} lines · ${dur}`));

    const out = h('div', 'ls-summary');
    if (lastSummary) out.textContent = lastSummary;

    const row1 = h('div', 'ls-consentrow');
    const sum = h('button', 'ls-btn ls-primary', 'Summarize');
    sum.addEventListener('click', () => {
      sum.disabled = true; sum.textContent = 'Summarising…';
      out.textContent = '';
      try {
        chrome.runtime.sendMessage(
          { type: 'SUMMARIZE', transcript: sess.transcript, highlights: sess.highlights, sessionId: sess.id },
          (res) => {
            sum.disabled = false; sum.textContent = 'Summarize';
            if (chrome.runtime.lastError) { out.textContent = 'Error: ' + chrome.runtime.lastError.message; return; }
            if (!res) { out.textContent = 'No response.'; return; }
            if (res.error) { out.textContent = '⚠️ ' + res.error; return; }
            lastSummary = res.summary;
            out.textContent = res.summary || '(empty)';
            toast('Summary will be included in the export');
          });
      } catch (e) { sum.disabled = false; out.textContent = 'Error: ' + e.message; }
    });
    row1.appendChild(sum);
    box.appendChild(row1);

    const row2 = h('div', 'ls-consentrow');
    const md = h('button', 'ls-btn', 'Export .md');
    const txt = h('button', 'ls-btn', 'Export .txt');
    md.addEventListener('click', () => { download('md', buildMarkdown(sess, lastSummary), sess.title); markHandled(sess.id); });
    txt.addEventListener('click', () => { download('txt', buildText(sess, lastSummary), sess.title); markHandled(sess.id); });
    row2.append(md, txt);
    box.appendChild(row2);

    const row3 = h('div', 'ls-consentrow');
    const back = h('button', 'ls-btn', ended ? 'Not now' : 'Back to transcript');
    back.addEventListener('click', () => {
      markHandled(sess.id);
      el.classList.remove('ls-summary-open');
      if (ended) { hidePanel(); return; }
      C.setRecording(true); runningSince = Date.now();
      el.classList.remove('ls-paused');
      render(C.view());
    });
    row3.appendChild(back);
    box.appendChild(row3);
    box.appendChild(out);
    bodyEl.appendChild(box);
  }

  function finishRecording(heading, via) {
    if (!started || ended) return;
    ended = true;
    console.log('[LiveScribe] recording ended (signal: ' + (via || 'user') + ') — prompting to export');
    // Stop first so the collector commits its active caption and ignores any
    // further Zoom frames while the meeting itself is allowed to continue.
    C.setRecording(false);
    if (runningSince) { elapsedMs += Date.now() - runningSince; runningSince = null; }
    const snap = snapshot();
    snap.ended = true;
    try { chrome.runtime.sendMessage({ type: 'SAVE_SESSION', session: snap },
      () => void chrome.runtime.lastError); } catch (e) {}
    showExport(true, snap, heading);
  }

  function toast(msg) {
    const t = el.querySelector('.ls-toast');
    t.textContent = msg;
    t.classList.add('ls-show');
    setTimeout(() => t.classList.remove('ls-show'), 1500);
  }

  function makeDraggable(box, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
      box.style.right = 'auto'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      box.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      box.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  window.LSPanel = {
    mount(plat) {
      platform = plat || 'meeting';
      if (!el || !document.documentElement.contains(el)) { el = null; build(); }
      C.onChange(render);
    },
    exists() { return !!el && document.documentElement.contains(el); },
    meetingEnded(via) {
      finishRecording('Meeting ended — save your transcript?', via || 'view-gone');
    },

    // Called on every page load: the meeting tab is usually replaced when a call
    // ends, taking the in-page transcript with it, so an unhandled session from
    // the last hour gets its prompt here instead.
    resumePending(plat) {
      platform = plat || platform;
      try {
        chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.sessions) return;
          const cut = Date.now() - 60 * 60 * 1000;
          const p = res.sessions.find(x =>
            x && !x.handled && (x.lines || []).length && (x.endedAt || 0) > cut);
          if (!p || started) return;
          if (!el || !document.documentElement.contains(el)) { el = null; build(); }
          showExport(true, p);
        });
      } catch (e) { /* ignore */ }
    },
    isStarted() { return started; },
  };
})();
