// wshook.js — MAIN-world WebSocket / RTCDataChannel tap.
//
// WHY: DOM scraping is downstream of everything — it breaks when class names,
// layout, or the caption widget change. Captions arrive over the wire first, so
// tapping the transport is strictly more robust and gives structured data
// (speaker ids included) instead of text we have to re-parse.
//
// MUST run in the MAIN world at document_start: content scripts live in an
// isolated world and cannot patch the page's own WebSocket, and the page opens
// its sockets early — patch late and you miss the connection entirely.
//
// REALITY CHECK: Zoom's web client does not necessarily send captions as plain
// JSON (much of its traffic is binary/proprietary). So this ships in two modes:
//   * auto   — decode what we can, heuristically pull caption-shaped records,
//              and forward them to the extension.
//   * probe  — keep a ring buffer of message SHAPES (keys, sizes, short text
//              samples) so the real wire format can be inspected after one
//              meeting and a precise parser written.
// Nothing is sent anywhere; samples stay in the page and are only readable by
// the extension on request.

(function () {
  if (window.__LS_WS_HOOKED__) return;
  window.__LS_WS_HOOKED__ = true;

  const MAX_SAMPLES = 60;
  const samples = [];      // ring buffer for probe mode
  let emitted = 0;

  const TEXT_KEYS = /^(text|content|caption|captions|transcript|subtitle|sentence|msg|message|body|words?)$/i;
  const NAME_KEYS = /^(speaker|speakername|username|usern|displayname|name|user|from|sender|participantname)$/i;
  const ID_KEYS   = /^(seq|sn|id|msgid|sentenceid|itemid|utteranceid|sequence)$/i;

  const looksLikeSpeech = s =>
    typeof s === 'string' &&
    s.length >= 2 && s.length <= 2000 &&
    /[\p{L}]/u.test(s) &&                       // has letters (any script)
    !/^https?:\/\//i.test(s) &&
    !/^[A-Za-z0-9+/=]{40,}$/.test(s) &&         // not base64
    !/^[0-9a-f-]{20,}$/i.test(s);               // not a uuid/hash

  // Pull caption-shaped records out of an arbitrary decoded object.
  function extract(obj, out, depth) {
    out = out || []; depth = depth || 0;
    if (!obj || depth > 6) return out;
    if (Array.isArray(obj)) { for (const v of obj) extract(v, out, depth + 1); return out; }
    if (typeof obj !== 'object') return out;

    let text = null, speaker = null, id = null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (TEXT_KEYS.test(k) && looksLikeSpeech(v)) { if (!text || v.length > text.length) text = v; }
        else if (NAME_KEYS.test(k) && v.length <= 60 && looksLikeSpeech(v)) speaker = speaker || v;
      } else if ((typeof v === 'number' || typeof v === 'string') && ID_KEYS.test(k)) {
        id = id == null ? String(v) : id;
      }
    }
    if (text) out.push({ text, speaker: speaker || null, id });
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') extract(v, out, depth + 1);
    }
    return out;
  }

  function decode(data) {
    // -> { kind, json?, text?, bytes? }
    try {
      if (typeof data === 'string') {
        const s = data.trim();
        if (s[0] === '{' || s[0] === '[') {
          try { return { kind: 'json', json: JSON.parse(s) }; } catch (e) { /* fallthrough */ }
        }
        return { kind: 'string', text: data };
      }
      // Duck-type rather than `instanceof`: frames can originate in another
      // realm (iframe / worker), where `instanceof ArrayBuffer` is false.
      let buf = null;
      const tag = Object.prototype.toString.call(data);
      if (tag === '[object ArrayBuffer]') buf = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (buf) {
        const txt = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        const m = txt.match(/[{[][\s\S]{2,}[}\]]/);
        if (m) { try { return { kind: 'binary-json', json: JSON.parse(m[0]), bytes: buf.length }; } catch (e) {} }
        // Keep printable runs — binary protocols usually still carry the words.
        // Escapes, not literals: a literal U+FFFF here is a Unicode *noncharacter*,
        // and Chrome's stricter UTF-8 validation rejects the whole file
        // ("isn't UTF-8 encoded") even though it decodes fine everywhere else.
        const runs = (txt.match(/[\x20-\x7E\u00A0-\uFFFD]{6,}/g) || []).slice(0, 6);
        return { kind: 'binary', text: runs.join(' | '), bytes: buf.length };
      }
    } catch (e) { /* ignore */ }
    return { kind: 'other' };
  }

  function sample(dir, url, d) {
    const rec = {
      t: Date.now(), dir, url: String(url).slice(0, 120), kind: d.kind, bytes: d.bytes || 0,
      keys: d.json ? Object.keys(d.json).slice(0, 12) : undefined,
      preview: d.json ? JSON.stringify(d.json).slice(0, 400) : (d.text || '').slice(0, 300),
    };
    samples.push(rec);
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  function post(type, payload) {
    try { window.postMessage({ __livescribe: true, type, payload }, '*'); } catch (e) {}
  }

  function handle(dir, url, data) {
    // WebSocket's default binaryType is "blob", so binary frames often arrive as
    // Blobs — reading them is async. Miss this and every binary frame is dropped.
    if (Object.prototype.toString.call(data) === '[object Blob]' && data.arrayBuffer) {
      data.arrayBuffer().then(ab => handleSync(dir, url, ab)).catch(() => {});
      return false;
    }
    return handleSync(dir, url, data);
  }

  function handleSync(dir, url, data) {
    const d = decode(data);
    sample(dir, url, d);
    if (!d.json) return false;
    const hits = extract(d.json);
    for (const h of hits) {
      emitted++;
      post('LS_WS_CAPTION', { text: h.text, speaker: h.speaker, id: h.id, url: String(url).slice(0, 120) });
    }
    return hits.length > 0;
  }

  // ---- patch WebSocket -----------------------------------------------------
  const NativeWS = window.WebSocket;
  // Only sockets that actually carried captions count as "the meeting socket",
  // so background/telemetry connections closing cannot be mistaken for the call
  // ending.
  let carried = new WeakSet();

  function PatchedWS(url, protocols) {
    const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    try {
      ws.addEventListener('message', (ev) => {
        try { if (handle('in', url, ev.data)) carried.add(ws); } catch (e) {}
      });
      ws.addEventListener('close', () => {
        if (!carried.has(ws)) return;
        console.log('[LiveScribe] meeting websocket closed — call has ended');
        post('LS_MEETING_ENDED', { via: 'websocket-close' });
      });
    } catch (e) {}
    const origSend = ws.send.bind(ws);
    ws.send = function (data) { try { sample('out', url, decode(data)); } catch (e) {} return origSend(data); };
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k, i) => { PatchedWS[k] = i; });
  try { window.WebSocket = PatchedWS; } catch (e) {}

  // ---- patch RTCDataChannel (some clients push captions over the peer conn) --
  try {
    const RP = window.RTCPeerConnection && window.RTCPeerConnection.prototype;
    if (RP && RP.createDataChannel) {
      const orig = RP.createDataChannel;
      RP.createDataChannel = function (...args) {
        const dc = orig.apply(this, args);
        try { dc.addEventListener('message', (ev) => { try { handle('in', 'rtc:' + args[0], ev.data); } catch (e) {} }); } catch (e) {}
        return dc;
      };
    }
  } catch (e) {}

  // ---- probe interface -----------------------------------------------------
  // Defined in the MAIN world on purpose: the DevTools console evaluates here,
  // so a helper defined by the content script would read as undefined.
  window.LSDumpWS = () => {
    const out = { framesSampled: samples.length, captionsEmitted: emitted, samples };
    console.log('[LiveScribe] WebSocket frame samples:');
    console.log(JSON.stringify(out, null, 2));
    return out;
  };

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.__livescribe_req) return;
    if (m.type === 'LS_WS_DUMP') post('LS_WS_SAMPLES', { samples: samples.slice(), emitted });
  });

  console.log('[LiveScribe] WebSocket tap installed (MAIN world). ' +
    'Run window.postMessage({__livescribe_req:1,type:"LS_WS_DUMP"},"*") to inspect captured frame shapes.');
})();
