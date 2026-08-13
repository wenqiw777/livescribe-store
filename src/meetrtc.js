// meetrtc.js — resilient MAIN-world Google Meet WebRTC caption capture.
//
// Google Meet sends captions through protobuf messages on RTC data channels.
// This module observes those channels before Meet creates its peer connection,
// subscribes to captions, resolves speaker device IDs, and recovers from channel
// replacement or silence without recording meeting audio.

(function () {
  if (window.__LS_MEET_RTC__) return;
  window.__LS_MEET_RTC__ = true;

  const EVENT = 'livescribe-meet';
  const LABEL_CAPTIONS = 'captions';
  const LABEL_MEDIA = 'media-session';
  const LABEL_COLLECTIONS = 'collections';
  const SYNC_COLLECTIONS = 'MeetingSpaceService/SyncMeetingSpaceCollections';
  const config = Object.assign({
    batchMs: 500,
    openDelayMs: 1500,
    healthMs: 10000,
    silenceMs: 60000,
    maxRecoveries: 3,
    parseGapPackets: 50,
    subscribeAckMs: 5000,
    disconnectGraceMs: 5000,
  }, window.__LS_MEET_CONFIG__ || {});

  function preferredLanguage() {
    return document.documentElement.lang || navigator.language || 'en-US';
  }

  const state = {
    pc: null,
    cc: null,
    ms: null,
    lang: preferredLanguage(),
    ended: false,
    emitted: 0,
    rawPackets: 0,
    parsedPackets: 0,
    parseMisses: 0,
    recoveries: 0,
    lastCaptionPacketAt: 0,
    lastCaptionParsedAt: 0,
    lastAudioEnergy: null,
    lastMediaResponseAt: 0,
  };
  window.__ls_meet = state;

  const DEC = new TextDecoder('utf-8', { fatal: false });
  const roster = new Map();
  const watched = new WeakSet();
  const pending = new Map();
  let flushTimer = null;
  let channelId = 50000;
  let subscriptionSeq = 0;
  let subscriptionTimer = null;
  let parseGapReported = false;
  let recoveryInFlight = false;
  let disconnectTimer = null;

  function dispatch(detail) {
    try {
      document.documentElement.dispatchEvent(new CustomEvent(EVENT, { detail }));
    } catch (e) { /* page is leaving */ }
  }

  function diagnostic(code, details) {
    const detail = Object.assign({ type: 'diagnostic', code }, details || {});
    console.warn('[LiveScribe] Meet ' + code, details || '');
    dispatch(detail);
  }

  // ---- protobuf wire helpers ----------------------------------------------
  function reader(bytes) { return { bytes, index: 0 }; }

  function varint(r) {
    let value = 0, shift = 0;
    while (r.index < r.bytes.length) {
      const byte = r.bytes[r.index++];
      value += (byte & 0x7f) * Math.pow(2, shift);
      if (!(byte & 0x80)) break;
      shift += 7;
      if (shift > 56) break;
    }
    return value;
  }

  function bytesOf(r) {
    const size = varint(r);
    if (!Number.isFinite(size) || size < 0 || r.index + size > r.bytes.length) {
      r.index = r.bytes.length;
      return new Uint8Array();
    }
    const out = r.bytes.subarray(r.index, r.index + size);
    r.index += size;
    return out;
  }

  function skip(r, wire) {
    if (wire === 0) varint(r);
    else if (wire === 1) r.index = Math.min(r.bytes.length, r.index + 8);
    else if (wire === 2) bytesOf(r);
    else if (wire === 5) r.index = Math.min(r.bytes.length, r.index + 4);
    else r.index = r.bytes.length;
  }

  function walk(bytes, visit) {
    const r = reader(bytes);
    let fields = 0;
    while (r.index < r.bytes.length && fields++ < 1000) {
      const key = varint(r);
      if (!key) break;
      const field = key >>> 3, wire = key & 7;
      if (!field || wire > 5) break;
      if (!visit(field, wire, r)) skip(r, wire);
    }
  }

  function dive(bytes, fields) {
    let current = bytes;
    for (const wanted of fields) {
      let next = null;
      walk(current, (field, wire, r) => {
        if (field === wanted && wire === 2 && !next) {
          next = bytesOf(r);
          return true;
        }
        return false;
      });
      if (!next || !next.length) return null;
      current = next;
    }
    return current;
  }

  function decodeTranscript(bytes) {
    const out = {};
    walk(bytes, (field, wire, r) => {
      if (field === 1 && wire === 2) { out.deviceId = DEC.decode(bytesOf(r)); return true; }
      if (field === 2 && wire === 0) { out.messageId = varint(r); return true; }
      if (field === 3 && wire === 0) { out.messageVersion = varint(r); return true; }
      if (field === 6 && wire === 2) { out.text = DEC.decode(bytesOf(r)); return true; }
      if (field === 8 && wire === 0) { out.langId = varint(r); return true; }
      return false;
    });
    if (!out.deviceId || !out.text || out.messageId == null) return null;
    out.messageVersion = out.messageVersion || 0;
    return out;
  }

  // The first decoder handles the current wrapper. The recursive decoder is a
  // bounded compatibility path for additional protobuf envelopes; it still
  // requires the full caption field set and never guesses based on random text.
  function decodeCaptionFrame(bytes) {
    const current = dive(bytes, [1]);
    const exact = (current && decodeTranscript(current)) || decodeTranscript(bytes);
    if (exact) return exact;

    const seen = new Set();
    function recurse(message, depth) {
      if (!message || !message.length || depth > 4) return null;
      const key = message.byteOffset + ':' + message.byteLength;
      if (seen.has(key)) return null;
      seen.add(key);
      const direct = decodeTranscript(message);
      if (direct) return direct;
      const children = [];
      walk(message, (field, wire, r) => {
        if (wire === 2) {
          const child = bytesOf(r);
          if (child.length >= 4) children.push(child);
          return true;
        }
        return false;
      });
      for (const child of children) {
        const found = recurse(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    return recurse(bytes, 0);
  }

  function readDevice(bytes) {
    const device = {};
    walk(bytes, (field, wire, r) => {
      if (field === 1 && wire === 2) { device.id = DEC.decode(bytesOf(r)); return true; }
      if (field === 2 && wire === 2) { device.name = DEC.decode(bytesOf(r)); return true; }
      return false;
    });
    if (!device.id || !device.name || !/devices\//.test(device.id)) return false;
    roster.set(device.id, device.name);
    return true;
  }

  function decodeRoster(bytes) {
    let found = 0;
    const visited = new Set();
    function recurse(message, depth) {
      if (!message || !message.length || depth > 6) return;
      const key = message.byteOffset + ':' + message.byteLength;
      if (visited.has(key)) return;
      visited.add(key);
      if (readDevice(message)) found++;
      walk(message, (field, wire, r) => {
        if (wire === 2) {
          const child = bytesOf(r);
          if (child.length >= 4) recurse(child, depth + 1);
          return true;
        }
        return false;
      });
    }
    recurse(bytes, 0);
    return found;
  }

  function rawBytes(data) {
    const tag = Object.prototype.toString.call(data);
    if (tag === '[object ArrayBuffer]') return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }

  function gzipOffset(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) return 0;
    if (bytes.length >= 6 && bytes[3] === 0x1f && bytes[4] === 0x8b && bytes[5] === 0x08) return 3;
    return -1;
  }

  async function decompress(bytes) {
    const offset = gzipOffset(bytes);
    if (offset < 0) return bytes;
    if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function') {
      diagnostic('gzip-unsupported');
      return null;
    }
    try {
      const stream = new Blob([bytes.subarray(offset)]).stream()
        .pipeThrough(new DecompressionStream('gzip'));
      const reader = stream.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        size += part.value.byteLength;
      }
      const out = new Uint8Array(size);
      let cursor = 0;
      for (const chunk of chunks) { out.set(chunk, cursor); cursor += chunk.byteLength; }
      return out;
    } catch (error) {
      diagnostic('gzip-decode-failed', { message: error && error.message });
      return null;
    }
  }

  // ---- caption batching ---------------------------------------------------
  function flushCaptions() {
    flushTimer = null;
    const messages = [...pending.values()];
    pending.clear();
    messages.sort((a, b) => a.receivedAt - b.receivedAt);
    for (const cap of messages) {
      state.emitted++;
      dispatch({
        type: 'speech',
        id: cap.id,
        speaker: cap.speaker,
        text: cap.text,
        version: cap.version,
      });
    }
  }

  function queueCaption(message) {
    const text = String(message.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const id = message.messageId + '/' + message.deviceId;
    const version = Number(message.messageVersion) || 0;
    const previous = pending.get(id);
    if (previous && previous.version > version) return;
    pending.set(id, {
      id,
      version,
      text,
      speaker: roster.get(message.deviceId) || null,
      receivedAt: Date.now(),
    });
    if (!flushTimer) flushTimer = setTimeout(flushCaptions, config.batchMs);
  }

  async function handleCaptionData(data) {
    if (Object.prototype.toString.call(data) === '[object Blob]' && data.arrayBuffer) {
      try { return handleCaptionData(await data.arrayBuffer()); } catch (e) { return; }
    }
    let bytes = rawBytes(data);
    if (!bytes || !bytes.length) return;
    state.rawPackets++;
    state.lastCaptionPacketAt = Date.now();
    bytes = await decompress(bytes);
    if (!bytes) return;

    let message = null;
    try { message = decodeCaptionFrame(bytes); } catch (e) { message = null; }
    if (!message) {
      state.parseMisses++;
      if (state.parseMisses >= config.parseGapPackets && !parseGapReported) {
        parseGapReported = true;
        diagnostic('caption-parse-gap', {
          consecutivePackets: state.parseMisses,
          firstBytes: Array.from(bytes.slice(0, 16)).join(','),
        });
      }
      return;
    }

    state.parsedPackets++;
    state.parseMisses = 0;
    state.recoveries = 0;
    state.lastCaptionParsedAt = Date.now();
    parseGapReported = false;
    queueCaption(message);
  }

  function handleCollectionsData(data) {
    if (Object.prototype.toString.call(data) === '[object Blob]' && data.arrayBuffer) {
      data.arrayBuffer().then(handleCollectionsData).catch(() => {});
      return;
    }
    const bytes = rawBytes(data);
    if (!bytes) return;
    const before = roster.size;
    try { decodeRoster(bytes); } catch (e) { /* schema drift is non-fatal */ }
    if (roster.size !== before) console.log('[LiveScribe] Meet roster: ' + roster.size + ' participants known');
  }

  // ---- caption subscription packets --------------------------------------
  const utf8 = value => Array.from(new TextEncoder().encode(value));
  function encodeVarint(value) {
    const out = [];
    while (value > 127) {
      out.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(value & 0x7f);
    return out;
  }
  const pbInt = (tag, value) => [...encodeVarint(tag), ...encodeVarint(value)];
  const pbLen = (tag, bytes) => [...encodeVarint(tag), ...encodeVarint(bytes.length), ...bytes];
  const pbStr = (tag, value) => pbLen(tag, utf8(value));

  function buildCaptionRequest(op, language) {
    const captionConfig = [...pbStr(10, language), ...pbStr(18, language)];
    const clientConfig = pbLen(74, captionConfig);
    const fieldMask = pbStr(10, 'client_config.caption_config');
    const captionUpdate = [...pbLen(10, clientConfig), ...pbLen(18, fieldMask)];
    const command = [...pbInt(8, op), ...pbLen(26, captionUpdate)];
    return new Uint8Array(pbLen(10, pbLen(18, command)));
  }

  function buildAck(seq) {
    return new Uint8Array(pbLen(10, pbLen(10, [...pbInt(16, seq), ...pbInt(24, 1)])));
  }

  function extractCaptionLanguage(bytes) {
    try {
      const captionConfig = dive(bytes, [1, 2, 3, 1, 9]);
      if (!captionConfig) return null;
      let language = null;
      walk(captionConfig, (field, wire, r) => {
        if (field === 1 && wire === 2) { language = DEC.decode(bytesOf(r)); return true; }
        return false;
      });
      return language;
    } catch (e) { return null; }
  }

  function observeMediaSend(channel) {
    if (channel.__ls_send_observed) return;
    const original = channel.send;
    if (typeof original !== 'function') return;
    try { Object.defineProperty(channel, '__ls_send_observed', { value: true }); } catch (e) { return; }
    channel.send = function (data) {
      try {
        const bytes = rawBytes(data);
        const language = bytes && extractCaptionLanguage(bytes);
        if (language) state.lang = language;
      } catch (e) { /* preserve Meet's send path */ }
      return original.apply(this, arguments);
    };
  }

  function subscribe(language) {
    const channel = state.ms;
    if (!channel || channel.readyState !== 'open') return false;
    const selected = language || state.lang || preferredLanguage();
    try {
      const op = ++subscriptionSeq;
      channel.send(buildCaptionRequest(op, selected));
      channel.send(buildAck(op));
      channel.send(buildAck(op + 1));
      state.lang = selected;
      const sentAt = Date.now();
      clearTimeout(subscriptionTimer);
      subscriptionTimer = setTimeout(() => {
        if (state.lastMediaResponseAt < sentAt) {
          diagnostic('caption-subscription-unconfirmed', { language: selected });
        }
      }, config.subscribeAckMs);
      console.log('[LiveScribe] requested Meet captions on media-session (lang ' + selected + ')');
      return true;
    } catch (error) {
      diagnostic('caption-subscription-failed', { message: error && error.message });
      return false;
    }
  }
  window.LSSubscribeMeet = subscribe;

  // ---- channel lifecycle --------------------------------------------------
  function canUsePC(pc) {
    return pc && pc === state.pc && pc.connectionState !== 'closed' && pc.connectionState !== 'failed';
  }

  function nextChannelId() { channelId += 1; return channelId; }

  function openCaptionChannel(reason, force) {
    const pc = state.pc;
    if (!canUsePC(pc)) return false;
    if (!force && state.cc && state.cc.readyState !== 'closed' && state.cc.readyState !== 'closing') return false;
    try {
      const channel = pc.createDataChannel(LABEL_CAPTIONS, {
        ordered: true,
        maxRetransmits: 10,
        id: nextChannelId(),
      });
      watch(channel, 'local:' + (reason || 'initial'));
      return true;
    } catch (firstError) {
      // Some Chromium/Meet combinations reserve explicit stream IDs. A fallback
      // keeps capture available even if the browser must allocate the ID.
      try {
        const channel = pc.createDataChannel(LABEL_CAPTIONS, { ordered: true, maxRetransmits: 10 });
        watch(channel, 'local-fallback:' + (reason || 'initial'));
        return true;
      } catch (error) {
        diagnostic('caption-channel-open-failed', { message: error && error.message });
        return false;
      }
    }
  }
  window.LSOpenMeetCaptions = () => openCaptionChannel('manual', true);

  function recoverCaptionChannel(reason) {
    if (recoveryInFlight || state.recoveries >= config.maxRecoveries) {
      if (state.recoveries >= config.maxRecoveries) {
        diagnostic('caption-recovery-exhausted', { reason, attempts: state.recoveries });
      }
      return false;
    }
    recoveryInFlight = true;
    state.recoveries++;
    const opened = openCaptionChannel(reason, true);
    recoveryInFlight = false;
    if (opened) {
      diagnostic('caption-channel-reopened', { reason, attempt: state.recoveries });
      subscribe(state.lang);
    }
    return opened;
  }

  function adoptCaptionChannel(channel, origin) {
    const previous = state.cc;
    state.cc = channel;
    state.lastCaptionPacketAt = Date.now();
    if (previous && previous !== channel && previous.readyState === 'open') {
      console.log('[LiveScribe] adopted newer Meet captions channel (' + origin + ')');
    }
    if (state.ms) subscribe(state.lang);
  }

  function watch(channel, origin) {
    if (!channel || watched.has(channel)) return;
    const label = channel.label;
    if (label !== LABEL_CAPTIONS && label !== LABEL_MEDIA && label !== LABEL_COLLECTIONS) return;
    watched.add(channel);

    if (label === LABEL_MEDIA) {
      state.ms = channel;
      subscriptionSeq = 0;
      observeMediaSend(channel);
      channel.addEventListener('message', () => {
        state.lastMediaResponseAt = Date.now();
        clearTimeout(subscriptionTimer);
      });
      const start = () => subscribe(state.lang);
      if (channel.readyState === 'open') start();
      else channel.addEventListener('open', start, { once: true });
      console.log('[LiveScribe] watching Meet media-session channel (' + origin + ')');
      return;
    }

    if (label === LABEL_COLLECTIONS) {
      channel.addEventListener('message', event => handleCollectionsData(event.data));
      console.log('[LiveScribe] watching Meet collections channel (' + origin + ')');
      return;
    }

    adoptCaptionChannel(channel, origin);
    channel.addEventListener('message', event => {
      handleCaptionData(event.data).catch(error => {
        diagnostic('caption-handler-failed', { message: error && error.message });
      });
    });
    channel.addEventListener('close', () => {
      if (state.cc === channel) {
        setTimeout(() => {
          if (state.cc === channel) recoverCaptionChannel('channel-closed');
        }, 0);
      }
    });
    console.log('[LiveScribe] watching Meet captions channel (' + origin + ')');
  }

  // ---- initial participant roster ----------------------------------------
  function decodeBase64Payload(text) {
    const cleaned = String(text || '').replace(/^\)\]\}'\s*/, '').trim().replace(/^"|"$/g, '');
    if (!cleaned) return null;
    try {
      const binary = atob(cleaned);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (e) { return null; }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function () {
      const args = arguments;
      return nativeFetch.apply(this, args).then(response => {
        try {
          const requestUrl = String(response && response.url || args[0] || '');
          if (requestUrl.includes(SYNC_COLLECTIONS) && response.clone) {
            response.clone().text().then(text => {
              const bytes = decodeBase64Payload(text);
              if (!bytes) return;
              const before = roster.size;
              decodeRoster(bytes);
              if (roster.size !== before) console.log('[LiveScribe] seeded Meet roster: ' + roster.size);
            }).catch(() => {});
          }
        } catch (e) { /* preserve fetch */ }
        return response;
      });
    };
  }

  // ---- WebRTC activity health --------------------------------------------
  async function audioEnergy(pc) {
    if (!pc || typeof pc.getStats !== 'function') return null;
    try {
      const reports = await pc.getStats();
      let total = 0, found = false;
      const visit = report => {
        const kind = report && (report.kind || report.mediaType);
        if (!report || report.type !== 'inbound-rtp' || kind !== 'audio') return;
        if (Number.isFinite(report.totalAudioEnergy)) {
          total += report.totalAudioEnergy;
          found = true;
        }
      };
      if (reports && typeof reports.forEach === 'function') reports.forEach(visit);
      return found ? total : null;
    } catch (e) { return null; }
  }

  async function healthTick() {
    const pc = state.pc;
    if (!canUsePC(pc)) return;
    if (state.cc && (state.cc.readyState === 'closed' || state.cc.readyState === 'closing')) {
      recoverCaptionChannel('channel-state-' + state.cc.readyState);
      return;
    }
    const energy = await audioEnergy(pc);
    if (energy == null) return;
    const previous = state.lastAudioEnergy;
    state.lastAudioEnergy = energy;
    const advancing = previous != null && energy > previous + 1e-9;
    const silentFor = Date.now() - (state.lastCaptionPacketAt || Date.now());
    if (advancing && silentFor >= config.silenceMs) {
      recoverCaptionChannel('audio-active-caption-silent');
    }
  }
  const healthTimer = setInterval(() => { healthTick().catch(() => {}); }, config.healthMs);

  // ---- RTCPeerConnection interception -------------------------------------
  const NativePC = window.RTCPeerConnection;
  if (NativePC) {
    const nativeCreateDataChannel = NativePC.prototype.createDataChannel;
    function PatchedPC() {
      const pc = Reflect.construct(NativePC, arguments, new.target || PatchedPC);
      const startingNewMeeting = state.ended;
      state.pc = pc;
      if (startingNewMeeting) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
        clearTimeout(subscriptionTimer);
        subscriptionTimer = null;
        clearTimeout(flushTimer);
        flushTimer = null;
        pending.clear();
        roster.clear();
        state.cc = null;
        state.ms = null;
        state.recoveries = 0;
        state.lastAudioEnergy = null;
        state.lastCaptionPacketAt = Date.now();
        state.lastCaptionParsedAt = 0;
        state.lastMediaResponseAt = 0;
        state.parseMisses = 0;
        parseGapReported = false;
        recoveryInFlight = false;
        subscriptionSeq = 0;
      }
      state.ended = false;
      try {
        pc.addEventListener('datachannel', event => watch(event.channel, 'remote'));
        pc.addEventListener('connectionstatechange', () => {
          if (state.pc !== pc) return;
          const connectionState = pc.connectionState;
          if (connectionState === 'connected' || connectionState === 'connecting') {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
            return;
          }
          const finish = endingState => {
            if (state.pc !== pc || state.ended) return;
            state.ended = true;
            dispatch({ type: 'ended', via: 'peerconnection-' + endingState });
          };
          if (connectionState === 'closed' || connectionState === 'failed') {
            clearTimeout(disconnectTimer);
            disconnectTimer = null;
            finish(connectionState);
          } else if (connectionState === 'disconnected' && !disconnectTimer) {
            disconnectTimer = setTimeout(() => {
              disconnectTimer = null;
              if (pc.connectionState === 'disconnected') finish('disconnected');
            }, config.disconnectGraceMs);
          }
        });
      } catch (e) { /* incomplete browser mock */ }
      setTimeout(() => {
        if (state.pc === pc) openCaptionChannel('initial', false);
      }, config.openDelayMs);
      return pc;
    }
    PatchedPC.prototype = NativePC.prototype;
    try {
      NativePC.prototype.createDataChannel = function () {
        const channel = nativeCreateDataChannel.apply(this, arguments);
        watch(channel, 'page');
        return channel;
      };
      window.RTCPeerConnection = PatchedPC;
      console.log('[LiveScribe] Meet WebRTC resilience tap installed (MAIN world)');
    } catch (error) {
      diagnostic('rtc-patch-failed', { message: error && error.message });
    }
  }

  window.LSDumpMeet = () => {
    const output = {
      captionsChannel: !!state.cc,
      captionsState: state.cc && state.cc.readyState,
      mediaSessionChannel: !!state.ms,
      peerConnection: !!state.pc,
      language: state.lang,
      rosterSize: roster.size,
      emitted: state.emitted,
      rawPackets: state.rawPackets,
      parsedPackets: state.parsedPackets,
      parseMisses: state.parseMisses,
      recoveries: state.recoveries,
      lastCaptionPacketAt: state.lastCaptionPacketAt,
      lastCaptionParsedAt: state.lastCaptionParsedAt,
    };
    console.log('[LiveScribe] Meet capture state:', output);
    return output;
  };
})();
