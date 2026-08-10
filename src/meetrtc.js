// meetrtc.js — MAIN-world WebRTC tap for Google Meet.
//
// Meet does not keep captions in a Redux store the way Zoom does; it streams
// them over a WebRTC DATA CHANNEL labelled "captions". Two consequences:
//   * reading them needs no DOM at all, so class-name churn and caption-box
//     dragging are irrelevant;
//   * the channel can be OPENED BY US. Meet's media server will serve captions
//     to a channel we create, so the on-screen CC toggle is not a prerequisite.
//
// MUST run in the MAIN world at document_start: an isolated content script
// cannot patch the page's RTCPeerConnection, and Meet builds its peer connection
// as soon as you join.
//
// PAYLOAD: protobuf. The field numbers are reverse-engineered and decoded
// exactly (see the schema note below) rather than inferred by shape — guessing
// produced no speaker names at all and confused long participant keys with
// speech. Speaker names come from the separate "collections" channel, which
// carries the deviceId -> displayName roster.

(function () {
  if (window.__LS_MEET_RTC__) return;
  window.__LS_MEET_RTC__ = true;

  const EVENT = 'livescribe-meet';
  const LABEL = 'captions';            // caption text arrives here
  const MEDIA_LABEL = 'media-session';  // session config is sent here
  const COLLECTIONS_LABEL = 'collections'; // participant records + speech
  const MAX_SAMPLES = 40;
  const samples = [];
  let emitted = 0;

  const state = { pc: null, cc: null, ms: null, lang: null, ended: false };
  window.__ls_meet = state;

  // ---- exact wire schema ---------------------------------------------------
  // Reverse-engineered field numbers, so captions are decoded rather than
  // guessed. Guessing cost us the speaker name entirely and mistook long
  // participant keys for speech.
  //
  //   captions channel:
  //     BTranscriptMessageWrapper { message = 1 -> BTranscriptMessage {
  //       deviceId = 1 (string), messageId = 2 (int64),
  //       messageVersion = 3 (int64), text = 6 (string), langId = 8 (int64) } }
  //
  //   collections channel (the participant roster):
  //     BMeetingCollection { 2 -> { 2 -> repeated 2 -> Device } }
  //     BDevice            { 1 -> 2 -> 13 -> 1 -> 2 -> Device }
  //     Device             { deviceId = 1 (string), deviceName = 2 (string) }
  const DEC = new TextDecoder('utf-8', { fatal: false });

  function rd(bytes) { return { b: bytes, i: 0 }; }
  function varint(r) {
    let x = 0, shift = 0;
    while (r.i < r.b.length) {
      const c = r.b[r.i++];
      x += (c & 0x7f) * Math.pow(2, shift);
      if (!(c & 0x80)) break;
      shift += 7;
      if (shift > 56) break;
    }
    return x;
  }
  function bytesOf(r) { const n = varint(r); const out = r.b.subarray(r.i, r.i + n); r.i += n; return out; }
  function skip(r, wire) {
    if (wire === 0) varint(r);
    else if (wire === 2) bytesOf(r);
    else if (wire === 5) r.i += 4;
    else if (wire === 1) r.i += 8;
    else r.i = r.b.length;
  }
  // Walk a message, handing (field, wire, reader) to a visitor.
  function walk(bytes, visit) {
    const r = rd(bytes);
    while (r.i < r.b.length) {
      const key = varint(r);
      if (!key) break;
      const field = key >>> 3, wire = key & 7;
      if (!visit(field, wire, r)) skip(r, wire);
    }
  }
  // Descend a chain of single length-delimited fields, e.g. [2,2,2].
  function dive(bytes, fields) {
    let cur = bytes;
    for (const want of fields) {
      let next = null;
      walk(cur, (f, w, r) => {
        if (f === want && w === 2 && !next) { next = bytesOf(r); return true; }
        return false;
      });
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  function decodeTranscript(bytes) {
    const out = {};
    walk(bytes, (f, w, r) => {
      if (f === 1 && w === 2) { out.deviceId = DEC.decode(bytesOf(r)); return true; }
      if (f === 2 && w === 0) { out.messageId = varint(r); return true; }
      if (f === 3 && w === 0) { out.messageVersion = varint(r); return true; }
      if (f === 6 && w === 2) { out.text = DEC.decode(bytesOf(r)); return true; }
      if (f === 8 && w === 0) { out.langId = varint(r); return true; }
      return false;
    });
    return out.text ? out : null;
  }

  function decodeCaptionFrame(bytes) {
    // The wrapper carries the transcript in field 1; some frames arrive bare.
    const inner = dive(bytes, [1]);
    return (inner && decodeTranscript(inner)) || decodeTranscript(bytes);
  }

  // deviceId -> display name, so speakers are named rather than inferred.
  const roster = new Map();

  function readDevice(bytes) {
    const d = {};
    walk(bytes, (f, w, r) => {
      if (f === 1 && w === 2) { d.deviceId = DEC.decode(bytesOf(r)); return true; }
      if (f === 2 && w === 2) { d.deviceName = DEC.decode(bytesOf(r)); return true; }
      return false;
    });
    if (d.deviceId && d.deviceName) { roster.set(d.deviceId, d.deviceName); return true; }
    return false;
  }

  function decodeRoster(bytes) {
    let found = 0;
    // BMeetingCollection: a repeated list of devices three levels down.
    const list = dive(bytes, [2, 2]);
    if (list) walk(list, (f, w, r) => {
      if (f === 2 && w === 2) { if (readDevice(bytesOf(r))) found++; return true; }
      return false;
    });
    // BDevice: a single device down a longer chain.
    const one = dive(bytes, [1, 2, 13, 1, 2]);
    if (one && readDevice(one)) found++;
    return found;
  }

  function handle(data, origin) {
    let bytes = null;
    const t = Object.prototype.toString.call(data);
    if (t === '[object ArrayBuffer]') bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (t === '[object Blob]' && data.arrayBuffer) {
      data.arrayBuffer().then(ab => handle(ab, origin)).catch(() => {});
      return;
    }
    if (!bytes || !bytes.length) return;
    if (samples.length < MAX_SAMPLES) samples.push({ origin, bytes: bytes.length });

    // The roster channel names the speakers; the captions channel carries speech.
    if (origin.indexOf(COLLECTIONS_LABEL) !== -1) {
      const before = roster.size;
      try { decodeRoster(bytes); } catch (e) { /* schema drift */ }
      if (roster.size !== before) console.log('[LiveScribe] Meet roster: ' + roster.size + ' participants known');
      return;
    }

    let m = null;
    try { m = decodeCaptionFrame(bytes); } catch (e) { m = null; }
    if (!m) return;
    emit({
      text: m.text.trim(),
      speaker: roster.get(m.deviceId) || null,
      id: m.messageId + '/' + m.deviceId,
      version: m.messageVersion,
    });
  }

  function emit(cap) {
    if (!cap.text) return;
    emitted++;
    try {
      document.documentElement.dispatchEvent(new CustomEvent(EVENT, {
        detail: { type: 'speech', id: cap.id, speaker: cap.speaker, text: cap.text },
      }));
    } catch (e) { /* ignore */ }
  }

  // ---- subscribing ---------------------------------------------------------
  // Opening the channel is not enough: Meet's media server sends nothing until
  // the client asks for captions on it. (Observed live: the channel opened, one
  // 4-byte handshake came back, and no captions ever followed.) The request is a
  // caption-config update, followed by two acks, exactly as Meet's own client
  // does it. Field numbers below are the wire schema of these messages:
  //
  //   BigPacket{ envelope=1 { command=2 { op=1, captionUpdate=3 {
  //       clientConfig=1 { captionConfig=9 { lang_1=1, lang_2=2 } },
  //       updateMask=2 { paths=1 } } } } }
  //   SmallPacket{ envelope=1 { ack=1 { seq=2, ok=3 } } }
  const utf8 = (s) => Array.from(new TextEncoder().encode(s));

  function vi(n) { const o = []; while (n > 127) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n & 0x7f); return o; }
  const pbInt = (tag, v) => [...vi(tag), ...vi(v)];
  const pbLen = (tag, bytes) => [...vi(tag), ...vi(bytes.length), ...bytes];
  const pbStr = (tag, s) => pbLen(tag, utf8(s));

  function buildCaptionRequest(op, lang) {
    const captionConfig = [...pbStr(10, lang), ...pbStr(18, lang)];
    const clientConfig = pbLen(74, captionConfig);
    const fieldMask = pbStr(10, 'client_config.caption_config');
    const captionUpdate = [...pbLen(10, clientConfig), ...pbLen(18, fieldMask)];
    const command = [...pbInt(8, op), ...pbLen(26, captionUpdate)];
    return new Uint8Array(pbLen(10, pbLen(18, command)));
  }

  function buildAck(seq) {
    const ack = [...pbInt(16, seq), ...pbInt(24, 1)];
    return new Uint8Array(pbLen(10, pbLen(10, ack)));
  }

  // The request does NOT go on the captions channel. Meet accepts session
  // configuration on a separate channel labelled "media-session"; sending it on
  // the captions channel gets no reply beyond the initial handshake, which is
  // exactly the dead end observed live (channel open, one 4-byte frame, no text).
  let seq = 0;
  function subscribe(lang) {
    const ch = state.ms;
    if (!ch) { console.warn('[LiveScribe] no "media-session" channel yet — join the meeting first'); return false; }
    if (ch.readyState !== 'open') { console.warn('[LiveScribe] "media-session" channel not open yet'); return false; }
    try {
      const op = ++seq;
      ch.send(buildCaptionRequest(op, lang || state.lang || 'en-US'));
      ch.send(buildAck(op));
      ch.send(buildAck(op + 1));
      console.log('[LiveScribe] requested Meet captions on the media-session channel (lang ' +
        (lang || state.lang || 'en-US') + ')');
      return true;
    } catch (e) {
      console.warn('[LiveScribe] caption request failed:', e.message);
      return false;
    }
  }
  window.LSSubscribeMeet = (lang) => subscribe(lang);

  // ---- channel wiring ------------------------------------------------------
  // Meet splits its data channels by job:
  //   media-session — session config goes OUT here (this is where we subscribe)
  //   captions      — caption text comes IN here
  //   collections   — participant records, and speech as well
  function watch(ch, origin) {
    if (!ch || ch.__ls_watched) return;
    const label = ch.label;
    if (label !== LABEL && label !== MEDIA_LABEL && label !== COLLECTIONS_LABEL) return;
    try { Object.defineProperty(ch, '__ls_watched', { value: true }); } catch (e) { return; }

    if (label === MEDIA_LABEL) {
      state.ms = ch;
      seq = 0;
      console.log('[LiveScribe] found Meet "media-session" channel (' + origin + ')');
      const go = () => subscribe(state.lang);
      if (ch.readyState === 'open') go();
      else ch.addEventListener('open', go, { once: true });
      return;
    }

    ch.addEventListener('message', (ev) => {
      // Never swallow silently: an exception here once looked exactly like
      // "the server sent nothing", which is a very expensive thing to debug.
      try { handle(ev.data, origin + ':' + label); }
      catch (e) { console.warn('[LiveScribe] Meet frame handler failed:', e && e.message); }
    });
    console.log('[LiveScribe] watching Meet "' + label + '" data channel (' + origin + ')');
  }

  // Meet's server will serve captions to a channel we open ourselves, which is
  // why captions need not be switched on in the UI first.
  function openCaptionChannel() {
    if (!state.pc || state.cc) return false;
    try {
      const ch = state.pc.createDataChannel(LABEL, { ordered: true, maxRetransmits: 10 });
      state.cc = ch;
      watch(ch, 'local');
      return true;
    } catch (e) {
      console.warn('[LiveScribe] could not open Meet captions channel:', e.message);
      return false;
    }
  }
  window.LSOpenMeetCaptions = openCaptionChannel;

  const NativePC = window.RTCPeerConnection;
  if (NativePC) {
    function PatchedPC(...args) {
      const pc = new NativePC(...args);
      state.pc = pc;
      try {
        pc.addEventListener('datachannel', (ev) => watch(ev.channel, 'remote'));
        // Leaving a call tears the peer connection down. That is a structural
        // fact about the call, unlike sniffing the URL or the DOM, which keep
        // looking "in a meeting" on the page that follows.
        pc.addEventListener('connectionstatechange', () => {
          const st = pc.connectionState;
          if (st !== 'closed' && st !== 'failed' && st !== 'disconnected') return;
          if (state.ended) return;
          state.ended = true;
          console.log('[LiveScribe] Meet peer connection ' + st + ' — call has ended');
          try {
            document.documentElement.dispatchEvent(new CustomEvent(EVENT, {
              detail: { type: 'ended', via: 'peerconnection-' + st },
            }));
          } catch (e) {}
        });
      } catch (e) {}
      // Give Meet a moment to finish negotiating before adding our channel.
      setTimeout(() => { if (state.pc === pc) openCaptionChannel(); }, 1500);
      return pc;
    }
    PatchedPC.prototype = NativePC.prototype;
    try {
      window.RTCPeerConnection = PatchedPC;
      const origCDC = NativePC.prototype.createDataChannel;
      NativePC.prototype.createDataChannel = function (...a) {
        const ch = origCDC.apply(this, a);
        watch(ch, 'page');
        return ch;
      };
      console.log('[LiveScribe] Meet WebRTC tap installed (MAIN world)');
    } catch (e) {
      console.warn('[LiveScribe] failed to patch RTCPeerConnection:', e.message);
    }
  }

  // Console helper — lives in the MAIN world where DevTools evaluates.
  window.LSDumpMeet = () => {
    const out = { captionsChannel: !!state.cc, peerConnection: !!state.pc, emitted, samples };
    console.log('[LiveScribe] Meet caption frames:');
    console.log(JSON.stringify(out, null, 2));
    return out;
  };
})();
