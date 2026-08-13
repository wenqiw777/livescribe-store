// meet.js — Google Meet capture (isolated world).
//
// Primary source is the WebRTC "captions" data channel tapped by meetrtc.js:
// structured, upstream of the UI, and it does not require the CC button. The
// behavioural DOM discovery stays as a fallback for when the channel can't be
// opened, and shuts off as soon as the channel delivers.

(function () {
  const C = window.LSCollector, P = window.LSPanel, A = window.LSAutoCapture;
  if (!C || !P || !A) return;

  // Meet's caption markup is obfuscated and changes; these are only nudges for
  // the fallback, never a requirement.
  const HINTS = [
    'div[aria-label="Captions"]',
    'div[role="region"][aria-label*="aption" i]',
    '.a4cQT',
  ];

  const isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  let cap = null, started = false, rtcLines = 0;

  function emit(key, speaker, text, finalize) {
    if (isTop) {
      if (!P.exists()) P.mount('Google Meet');
      C.update(key, speaker, text);
      if (finalize) C.finalize(key);
    }
    else {
      try {
        window.top.postMessage({ __livescribe: true, type: 'LS_FRAME_LINE',
          payload: { key: 'f' + key, speaker, text, finalize: !!finalize } }, '*');
      } catch (e) { /* cross-origin parent */ }
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe) return;
    if (m.type === 'LS_FRAME_LINE' && isTop) {
      const p = m.payload || {};
      if (!p.text) return;
      if (!P.exists()) P.mount('Google Meet');
      C.update(p.key, p.speaker, p.text);
      if (p.finalize) C.finalize(p.key);
    }
  });

  // --- WebRTC data-channel captions (preferred) ------------------------------
  document.documentElement.addEventListener('livescribe-meet', (ev) => {
    const d = ev.detail || {};
    if (d.type === 'ended') { if (P.meetingEnded) P.meetingEnded(d.via); return; }
    if (d.type === 'chat' && d.text) {
      emit('chat:' + d.id, (d.speaker || 'Participant') + ' · Chat', d.text, true);
      return;
    }
    if (d.type !== 'speech' || !d.text) return;
    rtcLines++;
    if (rtcLines === 1) {
      console.log('[LiveScribe] captions from Meet\'s data channel — DOM scraping disabled');
      if (cap && cap.stop) cap.stop();
    }
    emit('rtc:' + d.id, d.speaker || 'Speaker', d.text);
  });

  function boot() {
    // Meet meeting URLs look like /abc-defg-hij
    if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname) && !document.querySelector('[aria-label*="aption" i]')) return;
    if (isTop && !P.exists()) P.mount('Google Meet');
    if (started) return;
    started = true;

    cap = A.create({
      label: 'Meet captions',
      hints: HINTS,
      onLine: emit,
      onGone: (key) => { if (isTop) C.finalize(key); },
    });
    cap.start();
    console.log('[LiveScribe] Meet capture running.');
  }

  window.LSDebug = () => {
    console.log('[LiveScribe] frame:', isTop ? 'TOP' : 'child', '| rtc lines:', rtcLines);
    if (!cap) { console.warn('[LiveScribe] capture not started in this frame'); return null; }
    const d = cap.diagnose();
    console.log('[LiveScribe] locked:', d.locked, d.container || '');
    console.table(d.candidates.map(r => ({
      hits: r.hits, tag: r.tag, cls: r.cls, rejected: r.rejected || '(eligible)', text: r.text })));
    return d;
  };


  // When the meeting view goes away the transcript is finished — offer the
  // export right then, while the user is still looking at the tab.
  function inMeeting() { return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.pathname); }
  let wasIn = false;
  setInterval(() => {
    const now = inMeeting();
    if (now) wasIn = true;
    else if (wasIn) { wasIn = false; if (P.meetingEnded) P.meetingEnded(); }
  }, 2000);
  window.addEventListener('pagehide', () => { if (P.meetingEnded) P.meetingEnded(); }, { once: true });

  // A finished meeting usually navigates this tab away, destroying the panel and
  // its in-memory transcript before any prompt can be shown. Whatever was saved
  // gets its export prompt here, on whatever page loads next.
  if (P.resumePending) setTimeout(() => P.resumePending('Google Meet'), 800);

  const iv = setInterval(() => { boot(); if (started) clearInterval(iv); }, 500);
  boot();
})();
