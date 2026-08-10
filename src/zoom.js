// zoom.js — Zoom Web Client caption capture.
//
// No hard-coded position, no reliance on class names surviving. We hand a few
// *hints* to LSAutoCapture (fast path if they happen to match) and otherwise let
// it discover the caption container by behaviour, then follow that node. If you
// drag Zoom's caption box somewhere else, the node is the same — capture keeps
// working.
//
// Works when the meeting is open in the browser (…zoom.us/wc/…) with Zoom's own
// captions / live transcript turned on. The desktop app has no web DOM, so this
// route can't see it.

(function () {
  const C = window.LSCollector, P = window.LSPanel, A = window.LSAutoCapture;
  if (!C || !P || !A) return;

  const HINTS = [
    '[aria-live="polite"][class*="caption" i]',
    '.live-transcription-content',
    '[class*="live-transcription"]',
    '[class*="closed-caption" i]',
    '[class*="caption" i][class*="text" i]',
    '[aria-label*="aption" i]',
  ];

  let started = false;
  let wsLines = 0;

  // Zoom's web client runs the meeting across nested frames, so this script
  // loads more than once. Capture must happen in EVERY frame (captions may live
  // in a child frame), but only the top frame renders a panel — otherwise you
  // get one floating panel per frame. Child frames forward what they capture up.
  const isTop = (function () { try { return window.top === window; } catch (e) { return false; } })();

  // Zoom's signed-in shell also lives under /wc/ (notably /wc/home). Only the
  // concrete host/join routes are meetings. Treating the whole /wc/ namespace
  // as one caused auto-start to create a blank transcript as soon as a call
  // ended and Zoom returned to its home screen.
  function inMeeting() {
    return /\/wc\/[^/]+\/(?:start|join)(?:\/|$)/.test(location.pathname);
  }

  function emit(key, speaker, text) {
    if (!inMeeting()) return; // ignore late transport frames after the call ends
    if (isTop) { if (!P.exists()) P.mount('Zoom'); C.update(key, speaker, text); }
    else {
      try {
        window.top.postMessage({ __livescribe: true, type: 'LS_FRAME_LINE',
          payload: { key: 'f' + key, speaker, text } }, '*');
      } catch (e) { /* cross-origin parent — nothing we can do */ }
    }
  }

  // --- transport tap (preferred source) --------------------------------------
  // wshook.js runs in the MAIN world and forwards caption-shaped records here.
  // When these arrive we trust them over DOM scraping: they're upstream of the
  // UI, so restyling/dragging/class churn can't affect them.
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe) return;
    // LS_FRAME_LINE is forwarded UP from a child frame, so ev.source is that
    // frame — not this window. Requiring ev.source === window silently dropped
    // every caption captured in an iframe.
    if (m.type !== 'LS_FRAME_LINE' && ev.source !== window) return;
    if (m.type === 'LS_WS_CAPTION') {
      const p = m.payload || {};
      if (!p.text) return;
      wsLines++;
      if (wsLines === 1) console.log('[LiveScribe] captions arriving via WebSocket tap — DOM scraping now secondary');
      emit('ws:' + (p.id != null ? p.id : p.text.slice(0, 24)), p.speaker || 'Speaker', p.text);
    } else if (m.type === 'LS_FRAME_LINE' && isTop) {
      const p = m.payload || {};
      if (!p.text) return;
      emit(p.key, p.speaker, p.text);
    } else if (m.type === 'LS_MEETING_ENDED') {
      if (P.meetingEnded) P.meetingEnded((m.payload || {}).via);
    } else if (m.type === 'LS_WS_SAMPLES') {
      console.log('[LiveScribe] WS frame samples:', m.payload);
    }
  });

  // Console helper for inspecting the real wire format during a meeting.
  window.LSDumpWS = () => window.postMessage({ __livescribe_req: 1, type: 'LS_WS_DUMP' }, '*');
  window.LSDumpStore = () => window.postMessage({ __livescribe_req: 1, type: 'LS_STORE_DUMP' }, '*');

  // --- Zoom Redux store tap (best source) ------------------------------------
  // zoomstore.js reads live-transcript ACTIONS before Zoom renders them, so each
  // line arrives with a stable message id and a real speaker name. Keyed by that
  // id, a revised line replaces itself instead of accumulating — none of the
  // rolling-window overlap that DOM scraping has to undo.
  let storeLines = 0;
  document.documentElement.addEventListener('livescribe-zoom', (ev) => {
    const d = ev.detail || {};
    if (d.type === 'speech') {
      if (!d.text) return;
      storeLines++;
      if (storeLines === 1) {
        // Both sources watching the same captions is what produced duplicated
        // lines in the panel. The store is strictly better — stable id per
        // utterance, real speaker name — so once it delivers, stop scraping.
        console.log('[LiveScribe] live transcript from Zoom\'s store — DOM scraping disabled');
        if (cap && cap.stop) cap.stop();
      }
      emit('zs:' + d.id, d.speaker || 'Speaker', d.text);
    } else if (d.type === 'cc-enable-result') {
      console.log('[LiveScribe] enable-captions request ' + (d.ok ? 'sent' : 'FAILED (meeting socket not reachable yet)'));
      if (P.onCaptionsEnabled) P.onCaptionsEnabled(d.ok);
    } else if (d.type === 'dump') {
      console.log('[LiveScribe] Zoom store diagnostics:', d);
    }
  });

  // Panel (isolated world) asks; zoomstore.js (main world) owns the socket.
  window.LSRequestCaptions = (lang) =>
    window.postMessage({ __livescribe_req: 1, type: 'LS_ENABLE_CC', lang }, '*');

  // Diagnostics must survive the case where capture never starts — that is when
  // they matter most — so `cap` lives out here rather than inside boot().
  let cap = null;

  function dumpDebug() {
    console.log('[LiveScribe] frame:', isTop ? 'TOP' : 'child', location.href.slice(0, 90));
    if (!cap) {
      console.warn('[LiveScribe] capture never started in this frame ' +
        '(not recognised as a meeting view). pathname=' + location.pathname);
      return null;
    }
    const d = cap.diagnose();
    console.log('[LiveScribe] locked:', d.locked, d.container || '');
    console.table(d.candidates.map(r => ({
      hits: r.hits, tag: r.tag, cls: r.cls, rejected: r.rejected || '(eligible)', text: r.text })));
    return d;
  }

  function dumpHTML() {
    const out = { frame: isTop ? 'TOP' : 'child', url: location.href.slice(0, 90), started: !!cap };
    const c = cap ? cap.diagnose().container : null;
    if (c) {
      out.lockedOuterHTML = c.outerHTML.slice(0, 4000);
      const up = [];
      let p = c.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        up.push({ tag: p.tagName, cls: String(p.className || '').slice(0, 80),
                  aria: p.getAttribute && p.getAttribute('aria-label') });
      }
      out.ancestors = up;
    } else {
      // Not locked: show whatever looks caption-ish so the real node is visible.
      out.candidates = [...document.querySelectorAll('[aria-live],[class*="caption" i],[class*="transcript" i],[class*="subtitle" i]')]
        .slice(0, 8).map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 80),
                                  html: el.outerHTML.slice(0, 800) }));
    }
    console.log('[LiveScribe] caption markup dump:');
    console.log(JSON.stringify(out, null, 2));
    return out;
  }

  // Requests come from the MAIN-world helpers, since that is where the console
  // evaluates. Also expose them here for anyone switching console context.
  window.LSDebug = dumpDebug;
  window.LSDumpHTML = dumpHTML;
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe_req || ev.source !== window) return;
    if (m.type === 'LS_DEBUG') dumpDebug();
    else if (m.type === 'LS_DUMP_HTML') dumpHTML();
  });

  function boot() {
    // Only engage inside an actual meeting view.
    if (!inMeeting()) return;
    if (isTop && !P.exists()) P.mount('Zoom');
    if (started) return;
    started = true;

    cap = A.create({
      label: 'Zoom captions',
      hints: HINTS,
      onLine: emit,
      onGone: (key) => { if (isTop) C.finalize(key); },
    });
    cap.start();

    console.log('[LiveScribe] Zoom capture running (auto-discovery). Turn on Zoom captions/CC.');
  }


  // When the meeting view goes away the transcript is finished — offer the
  // export right then, while the user is still looking at the tab.
  // Use the strict route predicate above; Zoom's shell contains plenty of
  // meeting-related text and classes even when no call is active.
  let wasIn = false;
  setInterval(() => {
    const now = inMeeting();
    if (now) wasIn = true;
    else if (wasIn) {
      wasIn = false;
      if (cap && cap.stop) cap.stop();
      if (P.meetingEnded) P.meetingEnded();
    }
  }, 2000);
  window.addEventListener('pagehide', () => { if (P.meetingEnded) P.meetingEnded(); }, { once: true });

  // A finished meeting usually navigates this tab away, destroying the panel and
  // its in-memory transcript before any prompt can be shown. Whatever was saved
  // gets its export prompt here, on whatever page loads next.
  if (P.resumePending) setTimeout(() => P.resumePending('Zoom'), 800);

  const iv = setInterval(() => { boot(); if (started) clearInterval(iv); }, 500);
  boot();
})();
