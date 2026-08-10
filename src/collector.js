// collector.js — platform-agnostic transcript store + caption de-duplication.
//
// Live captions are messy: a single spoken line grows word-by-word inside the
// same DOM node, then finalizes and scrolls away. Scrapers can't just append
// every mutation or you get thousands of partial duplicates. This module takes
// per-"line" updates keyed by a stable id and decides when a line is *done*.
//
// Scraper contract:
//   LSCollector.update(key, speaker, text)  // current full text of an in-progress line
//   LSCollector.finalize(key)               // line's DOM node disappeared -> commit it
// The collector also auto-commits any line that stops changing for STALE_MS.

(function () {
  if (window.LSCollector) return; // content scripts may re-run on SPA navigations

  const STALE_MS = 2500;    // commit a line this long after its last update
  const MAX_OVERLAP = 400;  // how far back to look for already-recorded text
  const MAX_LINE = 400;     // split a speaker's run into a new line past this
  const state = {
    active: new Map(),   // key -> { speaker, text, ts }
    lastCommitted: new Map(), // key -> text last committed, to suppress re-adds
    committed: [],       // { speaker, text, t }  (t = ms since session start)
    listeners: new Set(),
    sessionStart: Date.now(),
    recording: true,
  };

  function view() {
    const last = state.committed[state.committed.length - 1];
    let active = [...state.active.values()]
      .map(v => {
        // The live window still shows text we've already committed; showing it
        // verbatim repeats whole sentences under the transcript.
        const text = (last && last.speaker === v.speaker) ? newTail(last.text, v.text) : v.text;
        return { speaker: v.speaker, text, active: true };
      })
      .filter(v => v.text);

    // More than one source can be watching the same captions (several frames,
    // plus the DOM fallback alongside a transport tap), each under its own key.
    // Without this, the same sentence shows up as two in-progress lines.
    active = active
      .sort((a, b) => b.text.length - a.text.length)
      .filter((v, i, arr) => !arr.some((o, j) =>
        j < i && o.speaker === v.speaker && canon(o.text).includes(canon(v.text))));

    return { committed: state.committed, active, recording: state.recording };
  }

  function emit() {
    const v = view();
    state.listeners.forEach(fn => { try { fn(v); } catch (e) { /* noop */ } });
  }

  function sharesPrefix(a, b) {
    const n = Math.min(a.length, b.length, 10);
    return n > 0 && a.slice(0, n) === b.slice(0, n);
  }

  // Caption widgets are ROLLING WINDOWS: several sentences are visible at once
  // and old ones scroll off the top. Reading the window as a single line means
  // consecutive reads overlap heavily —
  //     "A B C" -> "B C D" -> "C D E"
  // and naively committing each one records the same speech three times. So we
  // measure how much of the new text we've already recorded and keep only the
  // genuinely new tail.
  // Compare on letters and digits only. Recognition revises punctuation and
  // spacing as it goes ("hear me? Hello" vs "hear me?Hello", "Hello , hello"),
  // so exact string overlap misses repeats that are plainly the same words.
  const canon = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // Index in `s` just past its first `n` canonical characters.
  function cutAfterCanon(s, n) {
    if (n <= 0) return 0;
    let seen = 0;
    for (let i = 0; i < s.length; i++) {
      if (canon(s[i])) seen++;
      if (seen >= n) return i + 1;
    }
    return s.length;
  }

  function overlapLen(prev, next) {
    const cp = canon(prev), cn = canon(next);
    const max = Math.min(cp.length, cn.length, MAX_OVERLAP);
    for (let n = max; n > 0; n--) {
      if (cp.endsWith(cn.slice(0, n))) return n;    // canonical chars, not raw
    }
    return 0;
  }

  // What part of `text` has not been recorded yet, given the tail of the
  // transcript so far. Returns '' when the window has not advanced.
  function newTail(prevText, text) {
    if (!prevText) return text;
    const cp = canon(prevText), ct = canon(text);
    if (!ct || cp.endsWith(ct) || cp.includes(ct)) return '';   // nothing new
    const ov = overlapLen(prevText, text);
    return ov > 0 ? text.slice(cutAfterCanon(text, ov)).trim() : text;
  }

  function update(key, speaker, text) {
    if (!state.recording) return;
    text = (text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;

    const cur = state.active.get(key);
    // Identical text is not an update. Refreshing the timestamp here would keep
    // resetting the staleness clock, so a line that stays on screen (notably the
    // LAST line of a meeting) would never be committed.
    if (cur && cur.text === text) return;
    // A line committed on staleness is usually still displayed, so the next
    // scrape re-reports it — which would resurrect it as a fresh "active" line
    // and show the same sentence twice. Ignore until the text actually changes.
    if (state.lastCommitted.get(key) === text) return;
    // A reused node whose text no longer extends the previous text means a NEW
    // utterance started in the same slot — commit the old one first.
    if (cur && cur.text && !sharesPrefix(cur.text, text) && !text.startsWith(cur.text)) {
      commit(key);
    }
    const prev = state.active.get(key);
    state.active.set(key, {
      speaker: speaker || prev?.speaker || cur?.speaker || 'Speaker',
      text,
      ts: Date.now(),
    });
    emit();
  }

  function commit(key) {
    const cur = state.active.get(key);
    state.active.delete(key);
    if (!cur) return;
    const text = cur.text.trim();
    if (!text) return;
    state.lastCommitted.set(key, text);
    const last = state.committed[state.committed.length - 1];

    // With several sources committing the same speech under different keys, the
    // duplicate may not land immediately after the original — look back a few
    // lines before recording it again.
    const ct = canon(text);
    if (ct) {
      for (let i = state.committed.length - 1, seen = 0; i >= 0 && seen < 4; i--, seen++) {
        const l = state.committed[i];
        if (l.speaker === cur.speaker && canon(l.text).includes(ct)) { emit(); return; }
      }
    }

    if (last && last.speaker === cur.speaker) {
      const add = newTail(last.text, text);
      if (!add) { emit(); return; }                 // already recorded — drop it
      // Continuation of the same speaker: extend the line rather than repeating
      // the overlapping part, splitting only when a line gets unwieldy.
      if (last.text.length + add.length + 1 <= MAX_LINE) {
        last.text = (last.text + ' ' + add).trim();
        emit(); return;
      }
      state.committed.push({ speaker: cur.speaker, text: add, t: cur.ts - state.sessionStart, hl: false });
      emit(); return;
    }
    state.committed.push({ speaker: cur.speaker, text, t: cur.ts - state.sessionStart, hl: false });
    emit();
  }

  function finalize(key) { commit(key); }

  function sweep() {
    const now = Date.now();
    for (const [key, v] of [...state.active]) {
      if (now - v.ts > STALE_MS) commit(key);
    }
  }
  const sweepTimer = setInterval(sweep, 1000);

  window.LSCollector = {
    update,
    finalize,
    onChange(fn) { state.listeners.add(fn); fn(view()); return () => state.listeners.delete(fn); },
    view,
    setRecording(on) {
      state.recording = on;
      if (!on) for (const key of [...state.active.keys()]) commit(key);
      emit();
    },
    isRecording() { return state.recording; },
    reset() {
      state.active.clear();
      state.lastCommitted.clear();
      state.committed = [];
      state.sessionStart = Date.now();
      emit();
    },
    startedAt() { return state.sessionStart; },
    // Plain-text transcript for export / summarization.
    toText() {
      return state.committed.map(l => `${l.speaker}: ${l.text}`).join('\n');
    },
    lineCount() { return state.committed.length; },
    // Tactiq's "click quotes to highlight key points": marked lines are shown
    // differently and are handed to the model as the parts that mattered.
    toggleHighlight(i) {
      const l = state.committed[i];
      if (!l) return false;
      l.hl = !l.hl;
      emit();
      return l.hl;
    },
    highlights() {
      return state.committed.filter(l => l.hl).map(l => `${l.speaker}: ${l.text}`);
    },
    _stop() { clearInterval(sweepTimer); },
  };
})();
