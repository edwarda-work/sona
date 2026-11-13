// MAIN world (prototype): make the customer's voice clearer for the agent.
// The call site keeps the original remote stream; Sona swaps the element's
// playback to a processed copy only once RNNoise is ready, and restores the
// original on any failure.
(() => {
  const mediaProto = window.HTMLMediaElement?.prototype;
  const nativeSrc = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, 'srcObject');
  if (!nativeSrc?.get || !nativeSrc?.set || !nativeSrc.configurable || !window.AudioContext) return;

  const STARTUP_MS = 3000;
  const HEARTBEAT_MS = 2500;
  const remoteTracks = new WeakSet();
  const peerConnections = new Set();
  const requested = new WeakMap(); // element -> stream the page assigned
  const sessions = new Map();      // element -> processing session
  const failedStreams = new WeakSet();
  const elements = new Set();      // elements currently showing a remote stream
  const modelCache = new Map();
  let config = null;

  const nativeGet = el => nativeSrc.get.call(el);
  const nativeSet = (el, value) => nativeSrc.set.call(el, value);
  const log = (...args) => console.info('[Sona incoming]', ...args);

  // --- Remote track discovery -------------------------------------------
  function rememberPeer(pc) {
    if (!pc || peerConnections.has(pc)) return;
    peerConnections.add(pc);
    pc.addEventListener?.('track', event => {
      if (event.track?.kind === 'audio') remoteTracks.add(event.track);
    });
  }

  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const Original = window[key];
    if (typeof Original !== 'function') continue;
    function SonaIncomingPeerConnection(...args) {
      const pc = new Original(...args);
      rememberPeer(pc);
      return pc;
    }
    SonaIncomingPeerConnection.prototype = Original.prototype;
    Object.setPrototypeOf(SonaIncomingPeerConnection, Original);
    window[key] = SonaIncomingPeerConnection;
    const close = Original.prototype.close;
    if (typeof close === 'function' && !Original.prototype.close.__sonaIncoming) {
      const wrapped = function () {
        peerConnections.delete(this);
        return close.call(this);
      };
      wrapped.__sonaIncoming = true;
      Original.prototype.close = wrapped;
    }
  }

  function isRemoteAudio(track) {
    if (!track || track.kind !== 'audio' || track.readyState === 'ended') return false;
    if (remoteTracks.has(track)) return true;
    for (const pc of peerConnections) {
      if (pc.getReceivers?.().some(receiver => receiver.track === track)) {
        remoteTracks.add(track);
        return true;
      }
    }
    return false;
  }

  function remoteAudioOf(stream) {
    if (!stream || typeof stream.getAudioTracks !== 'function') return [];
    return stream.getAudioTracks().filter(isRemoteAudio);
  }

  // --- RNNoise helpers (duplicated from noise-suppression.js for the prototype)
  function withTimeout(promise, label, ms = STARTUP_MS) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })
    ]).finally(() => clearTimeout(timer));
  }

  function loadModel(baseUrl) {
    if (modelCache.has(baseUrl)) return modelCache.get(baseUrl);
    const loading = (async () => {
      const simd = WebAssembly.validate(new Uint8Array([
        0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
      ]));
      const response = await withTimeout(fetch(baseUrl + (simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm')),
        'RNNoise download timed out');
      if (!response.ok) throw new Error('RNNoise download failed');
      return withTimeout(response.arrayBuffer(), 'RNNoise download timed out');
    })();
    modelCache.set(baseUrl, loading);
    loading.catch(() => modelCache.delete(baseUrl));
    return loading;
  }

  // --- Sessions ------------------------------------------------------------
  function playIfWasPlaying(el, wasPlaying) {
    if (wasPlaying && el.paused) void el.play?.().catch(() => {});
  }

  function closeSession(session) {
    if (session.closed) return;
    session.closed = true;
    clearInterval(session.watchdog);
    session.node?.port.postMessage('destroy');
    for (const node of [session.source, session.filter, session.node, session.leveler, session.limiter]) {
      node?.disconnect?.();
    }
    session.output?.stop?.();
    // Detach the keep-alive player last so the remote stream never stalls mid-switch.
    if (session.keeper) {
      session.keeper.pause?.();
      nativeSet(session.keeper, null);
    }
    if (session.context) void session.context.close().catch(() => {});
    if (sessions.get(session.element) === session) sessions.delete(session.element);
  }

  // Put the page's own stream back on the element, then release the graph.
  function restore(session, reason, { markFailed = true } = {}) {
    if (session.closed) return;
    const el = session.element;
    if (markFailed) {
      failedStreams.add(session.original);
      console.warn('[Sona incoming] Using original customer audio:', reason);
    }
    if (requested.get(el) === session.original && nativeGet(el) === session.processed) {
      const wasPlaying = !el.paused;
      nativeSet(el, session.original);
      playIfWasPlaying(el, wasPlaying);
    }
    closeSession(session);
  }

  async function start(session) {
    const { element: el, original } = session;
    try {
      const context = session.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await withTimeout(context.resume(), 'Audio context did not start');
      if (context.state !== 'running' || session.closed) throw new Error('Audio context unavailable');
      await withTimeout(context.audioWorklet.addModule(config.baseUrl + 'rnnoiseWorkletProcessor.js'),
        'RNNoise worklet load timed out');
      const binary = await loadModel(config.baseUrl);
      if (session.closed) return;
      const node = session.node = new AudioWorkletNode(context, '@sapphi-red/web-noise-suppressor/rnnoise', {
        channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
        processorOptions: { maxChannels: 1, wasmBinary: binary }
      });
      await withTimeout(new Promise((resolve, reject) => {
        node.port.onmessage = ({ data }) => {
          if (data?.type === 'ready') resolve();
          else if (data?.type === 'error') reject(new Error(data.message));
          else if (data?.type === 'heartbeat') session.lastBeat = Date.now();
        };
        node.onprocessorerror = () => reject(new Error('RNNoise processor failed'));
      }), 'RNNoise initialization timed out');
      if (session.closed) return;

      // Chrome only feeds remote WebRTC audio into Web Audio while the stream
      // is also attached to a media element, so keep a muted player on it.
      const keeper = session.keeper = new Audio();
      keeper.muted = true;
      nativeSet(keeper, original);
      void keeper.play?.().catch(() => {});

      const source = session.source = context.createMediaStreamSource(original);
      const filter = session.filter = SonaVoiceFilter.createRumbleFilter(context);
      const leveler = session.leveler = SonaVoiceFilter.createCustomerLeveler(context);
      const limiter = session.limiter = SonaVoiceFilter.createPeakLimiter(context);
      const destination = context.createMediaStreamDestination();
      source.connect(filter).connect(node).connect(leveler).connect(limiter).connect(destination);
      session.output = destination.stream.getAudioTracks()[0];
      session.processed = new MediaStream([session.output]);

      session.lastBeat = Date.now();
      context.onstatechange = () => {
        if (!session.closed && context.state !== 'running') restore(session, 'Audio context stopped');
      };
      node.onprocessorerror = () => restore(session, 'RNNoise processor failed');
      session.watchdog = setInterval(() => {
        if (!session.closed && Date.now() - session.lastBeat > HEARTBEAT_MS) {
          restore(session, 'RNNoise stopped processing');
        }
      }, 1000);

      // The page may have moved on while we were loading.
      if (session.closed || requested.get(el) !== original || !config?.incomingEnabled) {
        closeSession(session);
        return;
      }
      const wasPlaying = !el.paused;
      nativeSet(el, session.processed);
      playIfWasPlaying(el, wasPlaying);
      log('Customer audio filtering active');
    } catch (error) {
      if (!session.closed) restore(session, error.message);
    }
  }

  function consider(el) {
    const stream = requested.get(el);
    const existing = sessions.get(el);
    if (existing && (existing.original !== stream || !config?.incomingEnabled)) {
      restore(existing, 'released', { markFailed: false });
    }
    const remote = remoteAudioOf(stream);
    if (!remote.length) { elements.delete(el); return; }
    elements.add(el);
    if (!config?.incomingEnabled || sessions.has(el) || failedStreams.has(stream)) return;
    // Video elements would flicker on a srcObject swap; audio-only for now.
    if (stream.getVideoTracks?.().length) { log('Skipping stream with video tracks'); return; }
    const session = { element: el, original: stream, closed: false };
    sessions.set(el, session);
    for (const track of remote) {
      track.addEventListener?.('ended', () => {
        if (remote.every(item => item.readyState === 'ended')) restore(session, 'remote track ended', { markFailed: false });
      }, { once: true });
    }
    void start(session);
  }

  // --- Hooks -----------------------------------------------------------------
  Object.defineProperty(mediaProto, 'srcObject', {
    configurable: true,
    enumerable: nativeSrc.enumerable,
    get() { return requested.has(this) ? requested.get(this) : nativeGet(this); },
    set(value) {
      requested.set(this, value);
      nativeSet(this, value); // Customer is audible immediately, before RNNoise loads.
      consider(this);
    }
  });

  window.addEventListener('sona-audio-config', event => {
    const detail = event.detail;
    if (!detail || typeof detail.incomingEnabled !== 'boolean' ||
        !/^chrome-extension:\/\/[a-p]{32}\/vendor\/rnnoise\/$/.test(detail.baseUrl)) return;
    config = { incomingEnabled: detail.incomingEnabled, baseUrl: detail.baseUrl };
    if (config.incomingEnabled) void loadModel(config.baseUrl).catch(() => {});
    for (const el of [...elements]) consider(el);
  });

  window.addEventListener('pagehide', () => {
    for (const session of [...sessions.values()]) restore(session, 'page hidden', { markFailed: false });
  });

  window.dispatchEvent(new CustomEvent('sona-audio-config-request'));
})();
