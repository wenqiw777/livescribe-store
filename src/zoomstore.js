// zoomstore.js — MAIN-world tap on Zoom Web Client's Redux store.
//
// This replaces DOM scraping as the primary source for Zoom, and it is a
// different class of solution. Zoom's web client is a Redux app: live-transcript
// lines arrive as dispatched ACTIONS carrying structured data — message id,
// text, and the speaker's user record — before anything is rendered. Reading
// them there means:
//   * no dependence on class names, layout, or where the caption box is dragged
//   * no rolling-window overlap to de-duplicate: every utterance has a stable
//     msgId, so an update to a line replaces it instead of appending
//   * real speaker names (user.displayName), not avatar initials to guess from
//
// HOW THE HOOK WORKS: Redux hands the store's reducer every (state, action)
// pair. So we patch the Redux factory functions before Zoom builds its store,
// wrap the root reducer, and watch the actions stream past. The store itself is
// kept on window for debugging.
//
// MUST run in the MAIN world at document_start — an isolated content script
// cannot see or patch the page's Redux, and the store is created early.

(function () {
  if (window.__LS_ZOOM_STORE__) return;
  window.__LS_ZOOM_STORE__ = true;

  const EVENT = 'livescribe-zoom';
  let emitted = 0;
  const recentTypes = new Map();   // action type -> count, for diagnostics

  // Zoom pads transcript text with control characters; strip them or they end
  // up in the transcript as replacement glyphs.
  function sanitize(s) {
    if (typeof s !== 'string') return '';
    let t = s;
    if (t.codePointAt(0) === 12) t = t.slice(1);      // leading form feed
    t = t.replace(/\0/g, '').replace(/�/g, '');
    return t.trim();
  }

  function send(detail) {
    try {
      document.documentElement.dispatchEvent(
        new CustomEvent(EVENT, { detail })); // CustomEvent reaches the isolated
                                             // world without broadcasting to
                                             // other frames the way postMessage does
    } catch (e) { /* ignore */ }
  }

  function emitLine(id, name, rawText, lang) {
    const text = sanitize(rawText);
    if (!text || !id) return;
    emitted++;
    send({ type: 'speech', id, speaker: name || null, text, lang: lang || null });
  }

  // ---- action handling -----------------------------------------------------
  function onAction(action) {
    if (!action || typeof action.type !== 'string') return;
    const type = action.type;
    recentTypes.set(type, (recentTypes.get(type) || 0) + 1);
    const p = action.payload !== undefined && action.payload !== null ? action.payload : action;

    if (type === 'SET_NEW_L_T_MESSAGE') {
      // Live transcript batch. collection is keyed by message id; each entry
      // carries its own user record.
      const coll = p && p.collection;
      if (!coll) return;
      for (const item of Object.values(coll)) {
        if (!item) continue;
        const u = item.user || {};
        emitLine(`${item.msgId}/${u.zoomID}`, u.displayName, item.text, item.language);
      }
    } else if (type === 'UPDATE_MESSAGE') {
      // Single in-progress caption line being revised.
      emitLine(`${p.srcMsgID}/${p.userId}`, p.previousDisplayName, p.message);
    } else if (type === 'JOIN_MEETING_SUCCESS') {
      send({ type: 'ready' });
    }
  }

  // ---- Redux patching ------------------------------------------------------
  function wrapReducer(reducer) {
    if (typeof reducer !== 'function') return reducer;
    return function (state, action) {
      try { onAction(action); } catch (e) { /* never break the app */ }
      return reducer.apply(this, arguments);
    };
  }

  // Zoom Workplace runs TWO Redux apps: the portal shell (contacts, calendar,
  // meetings list) and the meeting client itself. Patching whichever we find
  // first usually lands on the shell, whose actions never contain speech — so
  // keep every store and pick the meeting one by capability when it matters.
  const stores = [];

  function remember(store) {
    if (store && stores.indexOf(store) === -1) stores.push(store);
    window.__ls_zoom_store = store;
    return store;
  }

  function patch(R) {
    if (!R || R.__ls_patched) return false;
    try { Object.defineProperty(R, '__ls_patched', { value: true }); } catch (e) { return false; }

    for (const name of ['createStore', 'legacy_createStore']) {
      const orig = R[name];
      if (typeof orig !== 'function') continue;
      R[name] = function (reducer, ...rest) {
        return remember(orig.call(this, wrapReducer(reducer), ...rest));
      };
    }
    // Redux Toolkit
    if (typeof R.configureStore === 'function') {
      const orig = R.configureStore;
      R.configureStore = function (opts) {
        if (opts && typeof opts.reducer === 'function') opts = { ...opts, reducer: wrapReducer(opts.reducer) };
        return remember(orig.call(this, opts));
      };
    }
    console.log('[LiveScribe] Zoom Redux patched — reading live transcript from store actions');
    return true;
  }

  // The meeting client lives in a same-origin iframe, and its Redux global
  // belongs to THAT window — a script in the parent never sees it unless it
  // reaches in deliberately. This is why patching only the top document caught
  // the portal store and no speech ever arrived.
  const MEETING_FRAME = '.pwa-webclient__iframe-wrapper iframe, iframe[src*="/wc/"]';
  function patchFrames() {
    let any = false;
    let frames;
    try { frames = document.querySelectorAll(MEETING_FRAME); } catch (e) { return false; }
    for (const f of frames) {
      try {
        const w = f.contentWindow;
        if (!w) continue;
        if (looksLikeRedux(w.Redux) && patch(w.Redux)) any = true;
      } catch (e) { /* cross-origin frame — nothing to do */ }
    }
    return any;
  }

  // Zoom exposes Redux as a global from one of its bundles, but the property
  // name is not guaranteed, so identify it structurally.
  function looksLikeRedux(o) {
    return o && typeof o === 'object' &&
      typeof o.createStore === 'function' &&
      typeof o.combineReducers === 'function';
  }

  function findAndPatch() {
    let got = patchFrames();          // meeting client first — that's the one with speech
    if (looksLikeRedux(window.Redux) && patch(window.Redux)) got = true;
    if (got) return true;
    let keys;
    try { keys = Object.getOwnPropertyNames(window); } catch (e) { return false; }
    for (const k of keys) {
      if (k === 'Redux') continue;
      let v;
      try { v = window[k]; } catch (e) { continue; }   // some getters throw
      if (looksLikeRedux(v) && patch(v)) return true;
    }
    return false;
  }

  // TIMING IS THE WHOLE GAME. Zoom creates its store almost immediately after
  // Redux becomes available, so polling loses the race: by the next tick the
  // store already exists and patching the factory is useless. Three defences,
  // strongest first.

  // 1. Intercept the assignment itself. The instant Zoom's bundle sets the
  //    global, we patch — there is no window in which the store can be built
  //    unpatched.
  function trapGlobal(name) {
    let held;
    try {
      const existing = Object.getOwnPropertyDescriptor(window, name);
      if (existing && !existing.configurable) return;
      if (existing) held = existing.value;
      Object.defineProperty(window, name, {
        configurable: true,
        get() { return held; },
        set(v) { held = v; try { if (looksLikeRedux(v)) patch(v); } catch (e) {} },
      });
    } catch (e) { /* ignore */ }
  }
  ['Redux', 'ReduxToolkit', 'RTK'].forEach(trapGlobal);

  // 2. Patch the moment Zoom's own bundles finish executing — the same hook
  //    point a script-tag injector would use.
  const BUNDLE = /(redux|externals)(\.\d+)?\.min\.js/i;
  function watchScript(el) {
    if (el.tagName !== 'SCRIPT') return;
    const src = el.getAttribute('src') || '';
    if (!BUNDLE.test(src)) return;
    el.addEventListener('load', () => { findAndPatch(); }, { once: true });
  }
  try {
    document.querySelectorAll('script').forEach(watchScript);
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) watchScript(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }

  // 3. Fast poll for the first seconds, then a permanent slow watcher.
  //    It must not stop on the first success: the portal store exists from the
  //    start, while the meeting iframe is created later — quitting early means
  //    only ever patching the shell, which carries no speech.
  findAndPatch();
  let fast = 0;
  const fastIv = setInterval(() => {
    findAndPatch();
    if (++fast > 400) clearInterval(fastIv);      // ~10s at 25ms
  }, 25);
  setInterval(findAndPatch, 1000);

  // If we never got in, say so loudly rather than sitting silent.
  setTimeout(() => {
    if (window.__ls_zoom_store) return;
    console.warn('[LiveScribe] Zoom Redux store was not captured. ' +
      'Either the store was built before this script ran, or Zoom does not expose Redux globally here. ' +
      'Run LSDumpStore() to see which actions this meeting dispatches.');
  }, 25000);

  // ---- turning the caption stream on --------------------------------------
  // Nothing can be read until Zoom is actually producing a live transcript, and
  // that is normally a manual step. Zoom's own client asks for it by sending a
  // message on the meeting websocket, so we can ask the same way.
  //
  // ⚠️ This is VISIBLE TO EVERYONE: Zoom announces "<name> has enabled live
  // transcription" to all participants. That is server-side behaviour and cannot
  // be suppressed from here. It is opt-in for that reason.
  const EVT_ENABLE_TRANSCRIPTION = 4285;
  const EVT_SET_LANGUAGE = 4305;

  // The store holding the meeting socket — not the portal shell's store.
  function meetingStore() {
    for (const s of stores) {
      try {
        const st = s.getState && s.getState();
        if (st && (st.WCSockets || typeof st.sendSocketMessage === 'function')) return s;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function sendSocket(msg) {
    const s = meetingStore();
    if (!s) return false;
    let st;
    try { st = s.getState(); } catch (e) { return false; }
    try {
      const sock = st.WCSockets && st.WCSockets.instance &&
                   st.WCSockets.instance.RWG && st.WCSockets.instance.RWG.socket;
      if (sock && typeof sock.send === 'function') { sock.send(JSON.stringify(msg)); return true; }
      // Older clients expose a thunk factory instead of the raw socket.
      const thunk = typeof st.sendSocketMessage === 'function' ? st.sendSocketMessage(msg) : null;
      if (typeof thunk === 'function') { thunk(); return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  function enableCaptions(lang) {
    const ok = sendSocket({ evt: EVT_ENABLE_TRANSCRIPTION });
    if (!ok) return false;
    if (lang != null) {
      // The language request is rejected if it arrives before transcription is
      // actually up, hence the delay Zoom's own flow uses.
      setTimeout(() => sendSocket({
        evt: EVT_SET_LANGUAGE, body: { type: 6, lang, nodeid: 0 },
      }), 5000);
    }
    return true;
  }

  window.LSEnableCaptions = (lang) => {
    const ok = enableCaptions(lang);
    console.log(ok
      ? '[LiveScribe] asked Zoom to start live transcription (all participants are notified by Zoom)'
      : '[LiveScribe] could not reach the meeting socket — join the meeting first, then retry');
    return ok;
  };

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe_req || m.type !== 'LS_ENABLE_CC') return;
    const ok = enableCaptions(m.lang);
    send({ type: 'cc-enable-result', ok });
  });

  // ---- diagnostics ---------------------------------------------------------
  // These are deliberately defined in the MAIN world. The DevTools console
  // evaluates in the page's world by default, so helpers defined by a content
  // script (isolated world) come back "undefined" when typed in — which makes
  // them useless exactly when something is wrong. The ones needing isolated-world
  // data post a request across; content-script console output still shows here.
  function defineHelpers() {
    window.LSDumpStore = () => {
      const types = [...recentTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
      const out = {
        reduxPatched: !!window.__ls_zoom_store,
        speechEventsEmitted: emitted,
        actionTypesSeen: types,
      };
      console.log('[LiveScribe] Zoom store diagnostics:');
      console.log(JSON.stringify(out, null, 2));
      if (!types.length) {
        console.warn('[LiveScribe] No Redux actions observed at all — the store was ' +
          'created before the hook, or this frame has no Zoom store. Try the top frame.');
      }
      return out;
    };
    // Served by the content script; output arrives via its console logs.
    window.LSDebug = () => {
      window.postMessage({ __livescribe_req: 1, type: 'LS_DEBUG' }, '*');
      return 'requested — see [LiveScribe] output below';
    };
    window.LSDumpHTML = () => {
      window.postMessage({ __livescribe_req: 1, type: 'LS_DUMP_HTML' }, '*');
      return 'requested — see [LiveScribe] output below';
    };
  }
  defineHelpers();

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe_req || m.type !== 'LS_STORE_DUMP') return;
    const top = [...recentTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    send({ type: 'dump', emitted, actionTypes: top, hasStore: !!window.__ls_zoom_store });
  });
})();
