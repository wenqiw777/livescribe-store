// autocapture.js — platform-agnostic caption discovery.
//
// WHY THIS EXISTS: hard-coded CSS selectors rot (Zoom/Meet obfuscate and change
// class names), and anchoring to screen position breaks the moment the user
// drags the caption box. So we don't use either as the primary strategy.
//
// Instead we find the caption container by BEHAVIOUR: captions are the thing on
// the page whose text keeps changing. We watch the whole document with a
// MutationObserver (event-driven — no polling), score elements that repeatedly
// change their text, and lock onto the best one. From then on we follow that
// NODE. Moving/restyling/re-parenting the box changes its position, not its
// identity, so dragging is a non-issue.
//
// Order of preference:
//   1. aria-live regions (semantic, required for screen readers, rarely changes)
//   2. caller-supplied hint selectors (fast path when they happen to match)
//   3. behavioural auto-discovery (the fallback that always works)

(function () {
  if (window.LSAutoCapture) return;

  const MIN_HITS = 3;      // distinct text changes before we trust a container
  const MAX_TEXT = 400;    // longer than this and it's a page region, not a caption
  const MAX_CLIMB = 4;     // how far up from a changed node we credit ancestors

  // Meeting chrome (toolbar, participant list, menus) churns its text constantly
  // (timers, mute state) and so out-scores the real caption box on "text keeps
  // changing" alone. Control DENSITY separates them: a toolbar has many controls,
  // a caption bubble has at most one small icon. Rejecting on the mere PRESENCE
  // of a control was too strict — it threw away Zoom's caption pill because of
  // its speaker avatar icon.
  const INTERACTIVE = 'button,[role="button"],a[href],input,select,textarea,' +
    '[role="menu"],[role="menuitem"],[role="toolbar"],[role="tablist"]';
  const MAX_CONTROLS = 1;
  // These never appear inside a caption box; they mark the video stage.
  const HARD_REJECT = 'video,canvas';

  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  function isOurs(el) {
    return !!(el.closest && el.closest('#ls-panel'));
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // eligible() is called for every mutation target and its ancestors, and the
  // structural checks below force synchronous layout. On a page as busy as a
  // meeting client that is the dominant cost, so memoise the verdict briefly —
  // an element does not change from "toolbar" to "caption box" within a second.
  const eligCache = new WeakMap();
  const ELIG_TTL = 1000;

  function eligibleUncached(el) {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (isOurs(el)) return false;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'INPUT' || tag === 'TEXTAREA') return false;
    const t = norm(el.innerText);
    if (!t || t.length > MAX_TEXT) return false;
    try {
      if (el.querySelector(HARD_REJECT)) return false;
      if (el.querySelectorAll(INTERACTIVE).length > MAX_CONTROLS) return false;
    } catch (e) { /* ignore */ }
    return isVisible(el);
  }

  // Could this element plausibly BE a caption container?
  function eligible(el) {
    if (!el || el.nodeType !== 1) return false;
    const now = Date.now();
    const hit = eligCache.get(el);
    if (hit && now - hit.at < ELIG_TTL) return hit.ok;
    const ok = eligibleUncached(el);
    eligCache.set(el, { at: now, ok });
    return ok;
  }

  function create(opts) {
    const { hints = [], onLine, label = 'captions' } = opts;
    const scores = new Map();    // element -> { hits, seen:Set<string> }
    const nodeIds = new WeakMap();
    let counter = 0;
    let container = null;
    let liveKeys = new Set();
    let observer = null;
    let tick = null;

    function idOf(node) {
      let id = nodeIds.get(node);
      if (!id) { id = 'c' + (++counter); nodeIds.set(node, id); }
      return id;
    }

    // ---- scoring / discovery -------------------------------------------------
    function credit(startEl) {
      let el = startEl, depth = 0;
      while (el && depth < MAX_CLIMB) {
        if (eligible(el)) {
          const t = norm(el.innerText);
          let rec = scores.get(el);
          if (!rec) { rec = { hits: 0, seen: new Set(), first: Date.now() }; scores.set(el, rec); }
          // Only count genuinely NEW text — a re-render with identical text isn't
          // evidence of a live caption.
          if (t && !rec.seen.has(t)) { rec.seen.add(t); rec.hits++; }
        }
        el = el.parentElement;
        depth++;
      }
    }

    // hintCandidates() runs querySelectorAll plus getComputedStyle and
    // getBoundingClientRect on each result — every one a forced synchronous
    // layout. Zoom mutates the DOM hundreds of times a second, so calling this
    // per mutation batch stalls discovery entirely. Cache it.
    let hintCache = null, hintCacheAt = 0;
    function hintedSet() {
      const now = Date.now();
      if (!hintCache || now - hintCacheAt > 2000) {
        hintCache = new Set(hintCandidates());
        hintCacheAt = now;
      }
      return hintCache;
    }

    function bestCandidate() {
      const hinted = hintedSet();
      let best = null, bestRec = null, bestHinted = false;
      for (const [el, rec] of scores) {
        if (!el.isConnected || rec.hits < MIN_HITS) continue;
        const isHinted = hinted.has(el);
        // A hint only wins if it ALSO changes. Locking on a hint alone grabbed
        // Zoom's static "Press shift+F10…" accessibility text, which matches
        // aria-live but never updates.
        if (best && isHinted !== bestHinted) {
          if (isHinted) { best = el; bestRec = rec; bestHinted = true; }
          continue;
        }
        if (!best) { best = el; bestRec = rec; bestHinted = isHinted; continue; }
        // Highest hit count wins. On a tie prefer the OLDER element: the caption
        // text node is destroyed and recreated every utterance, while the
        // container that holds it persists. Picking the long-lived ancestor is
        // what makes capture survive node churn (and dragging, which re-parents
        // the node without changing its identity).
        if (rec.hits > bestRec.hits ||
           (rec.hits === bestRec.hits && rec.first < bestRec.first)) {
          best = el; bestRec = rec; bestHinted = isHinted;
        }
      }
      return best;
    }

    function prune() {
      for (const el of [...scores.keys()]) if (!el.isConnected) scores.delete(el);
    }

    // Elements that LOOK like caption containers. These are only preferences —
    // a hint still has to prove itself by changing (see bestCandidate).
    function hintCandidates() {
      const out = [];
      for (const sel of hints) {
        try { document.querySelectorAll(sel).forEach(el => { if (eligible(el)) out.push(el); }); }
        catch (e) { /* bad selector, skip */ }
      }
      // aria-live is the most stable semantic hook — captions are announced to
      // screen readers, so platforms keep it even when class names churn.
      for (const el of document.querySelectorAll('[aria-live="polite"],[aria-live="assertive"]')) {
        if (eligible(el) && norm(el.innerText).length > 1) out.push(el);
      }
      return out;
    }

    function lock(el) {
      if (!el || el === container) return;
      container = el;
      liveKeys = new Set();
      console.log('[LiveScribe] locked onto ' + label + ' container:', el);
    }

    // ---- extraction ----------------------------------------------------------
    const GENERIC = /^(closed caption|captions?|live caption|subtitle|transcript|cc)$/i;

    // Zoom's caption bubble carries only the speaker's INITIALS ("AJ"); the full
    // name lives elsewhere in the meeting UI (video tile labels, participant
    // list). Resolve initials against those names so the transcript reads
    // "Alex Johnson:" instead of "AJ:". Only substitutes on a UNIQUE match, so an
    // ambiguous "AJ" stays as-is rather than being attributed to the wrong person.
    const NAME_RE = /^[\p{L}][\p{L}'’.\-]*(?:\s+[\p{L}'’.\-]+){0,3}$/u;
    let nameCache = null, nameCacheAt = 0;
    const NAME_TTL = 15000;

    function initialsOf(name) {
      return name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase();
    }

    function buildNameIndex() {
      const idx = new Map();   // initials -> Set(full names)
      let scanned = 0;
      const add = (t) => {
        t = norm(t);
        if (!t || t.length < 2 || t.length > 40 || !NAME_RE.test(t)) return;
        const k = initialsOf(t);
        if (!k) return;
        if (!idx.has(k)) idx.set(k, new Set());
        idx.get(k).add(t);
      };
      // Names show up both as visible tile labels and as accessibility labels.
      for (const el of document.querySelectorAll('[aria-label],[title]')) {
        add(el.getAttribute('aria-label')); add(el.getAttribute('title'));
        if (++scanned > 4000) break;
      }
      for (const el of document.querySelectorAll('span,div,p,li')) {
        if (++scanned > 12000) break;
        if (el.children.length) continue;         // leaf text only
        add(el.textContent);
      }
      return idx;
    }

    function expandInitials(init) {
      if (!/^[\p{Lu}]{1,3}$/u.test(init)) return null;
      const now = Date.now();
      if (!nameCache || now - nameCacheAt > NAME_TTL) {
        try { nameCache = buildNameIndex(); nameCacheAt = now; }
        catch (e) { return null; }
      }
      const hits = nameCache.get(init);
      if (!hits || hits.size !== 1) return null;   // ambiguous or unknown -> keep initials
      const full = [...hits][0];
      return initialsOf(full) === init && full.length > init.length ? full : null;
    }

    // Returns { speaker, text }. The speaker "chip" (avatar initials, name tag)
    // must be excluded from the spoken text — innerText concatenates it straight
    // onto the line, producing e.g. "SMproduct that solves…".
    function readBlock(block) {
      let speaker = 'Speaker', chip = null;

      // Descend through pure wrapper elements. Real caption markup nests the
      // pill inside one or more layout divs, so `block.children` is often just
      // [wrapper] — and the "short first child is the speaker" rule never fires,
      // leaving the initials glued to the text ("AJ Hello, hello…").
      while (block.children.length === 1 && norm(block.children[0].innerText) === norm(block.innerText)) {
        block = block.children[0];
      }

      // Explicit labels first — platforms expose "Name says: …" or a title on
      // the avatar for screen readers.
      for (const el of [block, ...block.querySelectorAll('[aria-label],[title],[data-name]')]) {
        if (!el.getAttribute) continue;
        const v = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-name'));
        if (!v || v.length > 60 || GENERIC.test(v)) continue;
        const m = v.match(/^(.+?)\s*(?:says?|:)\s*/i);
        speaker = norm(m ? m[1] : v);
        if (el !== block) chip = el;
        break;
      }
      // Otherwise: a short leading child next to a much longer sibling is
      // almost always the speaker chip.
      const kids = [...block.children];
      if (speaker === 'Speaker' && kids.length >= 2) {
        const first = norm(kids[0].innerText), rest = norm(kids[kids.length - 1].innerText);
        if (first && first.length <= 40 && rest.length > first.length) { speaker = first; chip = kids[0]; }
      }

      // Build the text from everything EXCEPT the chip's own subtree.
      let text = '';
      const chipTop = chip ? kids.find(k => k === chip || k.contains(chip)) : null;
      if (chipTop) {
        text = norm(kids.filter(k => k !== chipTop).map(k => k.innerText).join(' '));
      }
      if (!text) text = norm(block.innerText);

      // Strip any leftover leading chip text ("SM") or speaker name prefix.
      for (const pre of [chip && norm(chip.innerText), speaker]) {
        if (!pre) continue;
        const re = new RegExp('^' + pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:：]?\\s*', 'i');
        text = text.replace(re, '').trim();
      }
      // "AJ" -> "Alex Johnson" when the meeting UI makes that unambiguous.
      const full = expandInitials(speaker);
      if (full) speaker = full;
      return { speaker, text };
    }

    function blocksOf(el) {
      // Only children carrying SUBSTANTIAL text count as separate caption lines.
      // A short chip (avatar initials, a speaker name) is part of its line, not
      // a line of its own — splitting on it would emit "SM" as a phantom line.
      const kids = [...el.children].filter(c => norm(c.innerText).length > 25);
      return kids.length >= 2 ? kids : [el];
    }

    function harvest() {
      if (!container) return;
      if (!container.isConnected) {         // container was torn down — rediscover
        console.log('[LiveScribe] ' + label + ' container detached, rediscovering');
        container = null;
        prune();                            // keep history for surviving ancestors
        const next = bestCandidate();
        if (next) lock(next); else return;
      }
      const present = new Set();
      for (const b of blocksOf(container)) {
        const key = idOf(b);
        present.add(key);
        const { speaker, text } = readBlock(b);
        if (text) onLine(key, speaker, text);
      }
      for (const k of liveKeys) if (!present.has(k)) opts.onGone && opts.onGone(k);
      liveKeys = present;
    }

    // ---- driver --------------------------------------------------------------
    function onMutations(muts) {
      if (!container) {
        for (const m of muts) {
          const t = m.target;
          const el = t.nodeType === 1 ? t : t.parentElement;
          if (el) credit(el);
        }
        // Pick on every batch: with hints cached and eligibility memoised this
        // touches no layout. Throttling here cost us the first utterance of a
        // meeting, which is exactly when people say who they are.
        const found = bestCandidate();
        if (found) lock(found);
      }
      if (container) harvest();
    }

    function start() {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      // Safety net: if a caption box updates without firing mutations we'd see
      // (rare, e.g. shadow DOM swaps), a slow tick keeps us honest. 2s, not 400ms.
      tick = setInterval(() => {
        if (container) harvest();
        else { const f = bestCandidate(); if (f) lock(f); }
      }, 2000);
    }

    // Why did nothing lock? Report the elements that DID change text, and the
    // rule that disqualified each — far faster than guessing at selectors.
    function diagnose() {
      const why = (el) => {
        if (isOurs(el)) return 'is LiveScribe panel';
        const t = norm(el.innerText);
        if (!t) return 'no text';
        if (t.length > MAX_TEXT) return `text too long (${t.length} > ${MAX_TEXT})`;
        try {
          if (el.querySelector(HARD_REJECT)) return 'contains video/canvas';
          const n = el.querySelectorAll(INTERACTIVE).length;
          if (n > MAX_CONTROLS) return `too many controls (${n} > ${MAX_CONTROLS})`;
        } catch (e) {}
        if (!isVisible(el)) return 'not visible';
        return null;
      };
      const rows = [];
      for (const [el, rec] of scores) {
        rows.push({
          hits: rec.hits, tag: el.tagName,
          cls: String(el.className || '').slice(0, 60),
          connected: el.isConnected,
          rejected: why(el) || (rec.hits < MIN_HITS ? `only ${rec.hits} changes (need ${MIN_HITS})` : null),
          text: norm(el.innerText).slice(0, 90),
          el,
        });
      }
      rows.sort((a, b) => b.hits - a.hits);
      return { locked: !!container, container, candidates: rows.slice(0, 12) };
    }

    // If nothing locks on within a reasonable window, surface the diagnosis
    // automatically instead of leaving a silent "Waiting for captions…".
    setTimeout(() => {
      if (container) return;
      const d = diagnose();
      console.warn('[LiveScribe] no ' + label + ' container locked after 8s. ' +
        (d.candidates.length ? 'Top text-changing elements and why each was rejected:' :
         'NOTHING on this page changed text — captions may be in another frame, or CC is off.'));
      if (d.candidates.length) console.table(
        d.candidates.map(r => ({ hits: r.hits, tag: r.tag, cls: r.cls, rejected: r.rejected || '(eligible)', text: r.text })));
    }, 8000);

    return {
      start,
      isLocked: () => !!container,
      container: () => container,
      diagnose,
      stop() {
        if (observer) observer.disconnect();
        if (tick) clearInterval(tick);
        container = null;
      },
    };
  }

  window.LSAutoCapture = { create };
})();
