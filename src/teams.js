// teams.js — Microsoft Teams capture (isolated world).
//
// SCOPE, STATED PLAINLY: this uses the generic behavioural DOM discovery only.
// Tactiq taps Teams at the data layer (its msteams script hooks
// RTCPeerConnection/createDataChannel the way its Meet script does), but that
// protocol has not been reverse-engineered here, so Teams gets the fallback
// path: find the caption container by which element's text keeps changing, then
// follow that node. Live captions must be switched on in the Teams UI.
//
// The wshook.js transport tap also runs on Teams and will take over
// automatically if it recognises caption-shaped frames.

(function () {
  const C = window.LSCollector, P = window.LSPanel, A = window.LSAutoCapture;
  if (!C || !P || !A) return;

  const HINTS = [
    '[data-tid="closed-caption-text"]',
    '[data-tid*="caption" i]',
    '[class*="closed-caption" i]',
    '[aria-live="polite"][class*="caption" i]',
  ];

  const isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();
  let cap = null, started = false, wsLines = 0;

  function emit(key, speaker, text) {
    if (isTop) { if (!P.exists()) P.mount('Microsoft Teams'); C.update(key, speaker, text); }
    else {
      try {
        window.top.postMessage({ __livescribe: true, type: 'LS_FRAME_LINE',
          payload: { key: 'f' + key, speaker, text } }, '*');
      } catch (e) { /* cross-origin parent */ }
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe) return;
    if (m.type === 'LS_FRAME_LINE' && isTop) {
      const p = m.payload || {};
      if (!p.text) return;
      if (!P.exists()) P.mount('Microsoft Teams');
      C.update(p.key, p.speaker, p.text);
    } else if (m.type === 'LS_WS_CAPTION' && ev.source === window) {
      const p = m.payload || {};
      if (!p.text) return;
      wsLines++;
      if (wsLines === 1) {
        console.log('[LiveScribe] captions via transport tap — DOM scraping disabled');
        if (cap && cap.stop) cap.stop();
      }
      emit('ws:' + (p.id != null ? p.id : p.text.slice(0, 24)), p.speaker || 'Speaker', p.text);
    }
  });

  function boot() {
    if (!/\/v2\/|meetup-join|calling|modern-calling/.test(location.href) &&
        !document.querySelector('[data-tid*="caption" i],[class*="caption" i]')) return;
    if (isTop && !P.exists()) P.mount('Microsoft Teams');
    if (started) return;
    started = true;

    cap = A.create({
      label: 'Teams captions',
      hints: HINTS,
      onLine: emit,
      onGone: (key) => { if (isTop) C.finalize(key); },
    });
    cap.start();
    console.log('[LiveScribe] Teams capture running (DOM discovery). Turn on live captions in Teams.');
  }

  window.LSDebug = () => {
    console.log('[LiveScribe] frame:', isTop ? 'TOP' : 'child');
    if (!cap) { console.warn('[LiveScribe] capture not started in this frame'); return null; }
    const d = cap.diagnose();
    console.log('[LiveScribe] locked:', d.locked, d.container || '');
    console.table(d.candidates.map(r => ({
      hits: r.hits, tag: r.tag, cls: r.cls, rejected: r.rejected || '(eligible)', text: r.text })));
    return d;
  };


  // When the meeting view goes away the transcript is finished — offer the
  // export right then, while the user is still looking at the tab.
  function inMeeting() { return /\/v2\/|meetup-join|calling|modern-calling/.test(location.href) || !!document.querySelector('[data-tid*="caption" i]'); }
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
  if (P.resumePending) setTimeout(() => P.resumePending('Microsoft Teams'), 800);

  const iv = setInterval(() => { boot(); if (started) clearInterval(iv); }, 500);
  boot();
})();
