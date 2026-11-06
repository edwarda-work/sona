// MAIN world: keep the softphone's original audio available throughout a call.
(() => {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;

  const originalGetUserMedia = devices.getUserMedia.bind(devices);
  const originalTrackClone = MediaStreamTrack.prototype.clone;
  const originalTrackStop = MediaStreamTrack.prototype.stop;
  const nativeEnabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled');
  const originalStreamClone = MediaStream.prototype.clone;
  const captures = new WeakMap();
  const watchedTracks = new WeakSet();
  const senders = new Map();
  const trackedSenders = new Map();
  const requestedTracks = new WeakMap();
  const modelCache = new Map();
  const pendingFallbacks = new Set();
  const failedTracks = new WeakSet();
  let pageClosing = false;

  function phase() {
    if (!config) return 'starting';
    if (!config.enabled) return 'off';
    for (const [sender, track] of trackedSenders) {
      const session = captures.get(track);
      if (session?.output && sender.track === session.output && !session.closed) return 'filtering';
    }
    for (const track of trackedSenders.values()) {
      if (failedTracks.has(track)) return 'fallback';
    }
    for (const session of senders.values()) {
      if (session.loading && !session.closed) return 'starting';
    }
    return 'ready';
  }

  function publishState() {
    if (pageClosing) return;
    window.dispatchEvent(new CustomEvent('sona-audio-state', { detail: { phase: phase() } }));
  }
  const STARTUP_MS = 3000;
  const HEARTBEAT_MS = 2500;
  let config;

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

  function createWorklet(context, binary) {
    return new AudioWorkletNode(context, '@sapphi-red/web-noise-suppressor/rnnoise', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
      processorOptions: { maxChannels: 1, wasmBinary: binary }
    });
  }

  function waitForReady(node, session) {
    return withTimeout(new Promise((resolve, reject) => {
      node.port.onmessage = ({ data }) => {
        if (data?.type === 'ready') resolve();
        else if (data?.type === 'error') reject(new Error(data.message));
        else if (data?.type === 'heartbeat') session.lastBeat = Date.now();
      };
      node.onprocessorerror = () => reject(new Error('RNNoise processor failed'));
    }), 'RNNoise initialization timed out');
  }

  async function prepare(context, session) {
    await withTimeout(context.resume(), 'Audio context did not start');
    if (context.state !== 'running' || session.closed) throw new Error('Audio context unavailable');
    await withTimeout(context.audioWorklet.addModule(config.baseUrl + 'rnnoiseWorkletProcessor.js'),
      'RNNoise worklet load timed out');
    if (session.closed) throw new Error('Audio session ended');
    const binary = await loadModel(config.baseUrl);
    if (session.closed) throw new Error('Audio session ended');
    const node = session.node = createWorklet(context, binary);
    await waitForReady(node, session);
    if (session.closed) throw new Error('Audio session ended');
    return node;
  }

  function watch(session, fail) {
    session.lastBeat = Date.now();
    session.context.onstatechange = () => {
      if (session.closed) return;
      if (session.context.state !== 'running') fail('Audio context stopped');
    };
    session.node.onprocessorerror = () => {
      if (!session.closed) fail('RNNoise processor failed');
    };
    session.watchdog = setInterval(() => {
      if (session.closed) return;
      if (Date.now() - session.lastBeat > HEARTBEAT_MS) fail('RNNoise stopped processing');
    }, 1000);
  }

  const NativePC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  const nativeReplaceTrack = window.RTCRtpSender?.prototype.replaceTrack;

  function unbind(sender, forget = false) {
    if (forget) trackedSenders.delete(sender);
    const session = senders.get(sender);
    if (!session) return;
    senders.delete(sender);
    session.senders.delete(sender);
    if (!session.senders.size) session.close();
    publishState();
  }

  function attach(sender, track) {
    const captured = captures.has(track);
    unbind(sender);
    const session = captured && track.readyState === 'live' ? registerCapture(track) : null;
    if (session && track.readyState === 'live') trackedSenders.set(sender, track);
    else trackedSenders.delete(sender);
    if (!session || session.closed || !config?.enabled) return;
    senders.set(sender, session);
    session.senders.add(sender);
    if (session.output) queueSwitch(sender, session);
    else if (!session.loading) session.loading = startOutgoing(session);
    publishState();
  }

  function queueSwitch(sender, session) {
    const switching = switchToProcessed(sender, session);
    session.switches.add(switching);
    void switching.finally(() => session.switches.delete(switching));
  }

  async function switchToProcessed(sender, session) {
    if (session.closed || session.failing || senders.get(sender) !== session || sender.track !== session.input) return;
    try {
      await nativeReplaceTrack.call(sender, session.output);
      publishState();
      if (senders.get(sender) !== session || session.closed || session.failing) {
        if (sender.track === session.output) {
          await nativeReplaceTrack.call(sender, requestedTracks.get(sender) || session.input);
        }
      }
    } catch (error) {
      console.warn('[Sona audio] Could not switch outgoing track:', error.message);
      unbind(sender, true);
    }
  }

  function fallbackOutgoing(session, reason) {
    if (session.closed) return Promise.resolve();
    if (session.fallback) return session.fallback;
    session.failing = true;
    session.fallback = (async () => {
      console.warn('[Sona audio] Using original microphone:', reason);
      if (reason !== 'Suppression disabled' && reason !== 'Page hidden') failedTracks.add(session.input);
      if (config?.enabled && session.input.readyState === 'live') {
        void session.input.applyConstraints?.({ noiseSuppression: true }).catch(() => {});
      }
      if (session.output) session.input.enabled = session.output.enabled;
      await Promise.allSettled([...session.switches]);
      const replacements = [];
      for (const sender of session.senders) {
        if (sender.track === session.output) {
          replacements.push(Promise.resolve().then(() => nativeReplaceTrack.call(sender, session.input)).catch(error =>
            console.warn('[Sona audio] Microphone fallback failed:', error.message)));
        }
      }
      await Promise.allSettled(replacements);
      session.close();
      publishState();
    })();
    pendingFallbacks.add(session.fallback);
    void session.fallback.finally(() => pendingFallbacks.delete(session.fallback));
    return session.fallback;
  }

  async function startOutgoing(session) {
    try {
      const context = session.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      const node = await prepare(context, session);
      const source = session.source = context.createMediaStreamSource(new MediaStream([session.input]));
      const destination = session.destination = context.createMediaStreamDestination();
      const filter = session.filter = SonaVoiceFilter.createRumbleFilter(context);
      const limiter = session.limiter = SonaVoiceFilter.createPeakLimiter(context);
      source.connect(filter).connect(node).connect(limiter).connect(destination);
      session.output = destination.stream.getAudioTracks()[0];
      session.output.enabled = session.input.enabled;
      session.output.addEventListener('ended', () => fallbackOutgoing(session, 'Processed track ended'), { once: true });
      watch(session, reason => fallbackOutgoing(session, reason));
      for (const sender of session.senders) queueSwitch(sender, session);
      console.info('[Sona audio] Outgoing RNNoise ready');
    } catch (error) {
      if (!session.closed) fallbackOutgoing(session, error.message);
    }
  }

  function registerCapture(track) {
    const existing = captures.get(track);
    if (existing && !existing.closed) return existing;
    const session = {
      input: track, senders: new Set(), switches: new Set(), closed: false, loading: null,
      close() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.watchdog);
        for (const sender of this.senders) senders.delete(sender);
        this.senders.clear();
        this.node?.port.postMessage('destroy');
        this.node?.disconnect();
        this.source?.disconnect();
        this.filter?.disconnect();
        this.limiter?.disconnect();
        this.output?.stop();
        if (this.context) void this.context.close().catch(() => {});
      }
    };
    captures.set(track, session);
    failedTracks.delete(track);
    if (!watchedTracks.has(track)) {
      watchedTracks.add(track);
      track.addEventListener('ended', () => captures.get(track)?.close(), { once: true });
    }
    return session;
  }

  if (nativeEnabled?.get && nativeEnabled?.set && nativeEnabled.configurable) {
    Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
      configurable: true,
      enumerable: nativeEnabled.enumerable,
      get() { return nativeEnabled.get.call(this); },
      set(value) {
        nativeEnabled.set.call(this, value);
        const output = captures.get(this)?.output;
        if (output && output.readyState === 'live') nativeEnabled.set.call(output, value);
      }
    });
  }

  // A cloned microphone track needs its own lifecycle and denoiser.
  MediaStreamTrack.prototype.clone = function () {
    const copy = originalTrackClone.call(this);
    if (captures.has(this)) registerCapture(copy);
    return copy;
  };
  MediaStreamTrack.prototype.stop = function () {
    captures.get(this)?.close();
    return originalTrackStop.call(this);
  };
  MediaStream.prototype.clone = function () {
    if (!this.getAudioTracks().some(track => captures.has(track))) return originalStreamClone.call(this);
    return new MediaStream(this.getTracks().map(track => track.clone()));
  };

  if (NativePC && nativeReplaceTrack) {
    const pc = NativePC.prototype;
    const addTrack = pc.addTrack;
    pc.addTrack = function (track, ...streams) {
      const sender = addTrack.call(this, track, ...streams);
      if (track?.kind === 'audio') attach(sender, track);
      return sender;
    };
    if (pc.addTransceiver) {
      const addTransceiver = pc.addTransceiver;
      pc.addTransceiver = function (trackOrKind, init) {
        const transceiver = addTransceiver.call(this, trackOrKind, init);
        if (trackOrKind?.kind === 'audio') attach(transceiver.sender, trackOrKind);
        return transceiver;
      };
    }
    const removeTrack = pc.removeTrack;
    pc.removeTrack = function (sender) {
      const result = removeTrack.call(this, sender);
      unbind(sender, true);
      return result;
    };
    const close = pc.close;
    pc.close = function () {
      for (const sender of this.getSenders()) unbind(sender, true);
      return close.call(this);
    };
    window.RTCRtpSender.prototype.replaceTrack = async function (track) {
      const result = await nativeReplaceTrack.call(this, track);
      requestedTracks.set(this, track);
      attach(this, track);
      return result;
    };
  }

  devices.getUserMedia = async function (constraints) {
    if (!constraints?.audio) return originalGetUserMedia(constraints);
    if (!config?.enabled) {
      const stream = await originalGetUserMedia(constraints);
      for (const track of stream.getAudioTracks()) registerCapture(track);
      return stream;
    }
    const requested = typeof constraints.audio === 'object' ? constraints.audio : {};
    // RNNoise handles noise; the browser still handles acoustic echo.
    const audio = { ...requested, noiseSuppression: false, echoCancellation: true };
    let stream;
    try {
      stream = await originalGetUserMedia({ ...constraints, audio });
    } catch (error) {
      if (error.name !== 'OverconstrainedError') throw error;
      stream = await originalGetUserMedia(constraints);
    }
    for (const track of stream.getAudioTracks()) registerCapture(track);
    return stream; // The agent can speak before RNNoise has loaded.
  };

  window.addEventListener('sona-audio-config', event => {
    const detail = event.detail;
    if (!detail || typeof detail.enabled !== 'boolean' ||
        !/^chrome-extension:\/\/[a-p]{32}\/vendor\/rnnoise\/$/.test(detail.baseUrl)) return;
    const wasEnabled = config?.enabled;
    config = { enabled: detail.enabled, baseUrl: detail.baseUrl };
    if (config.enabled) void loadModel(config.baseUrl).catch(() => {});
    else {
      for (const session of [...new Set(senders.values())]) fallbackOutgoing(session, 'Suppression disabled');
    }
    publishState();
    if (config.enabled && wasEnabled !== true) {
      void Promise.allSettled([...pendingFallbacks]).then(() => {
        if (!config.enabled) return;
        for (const [sender, track] of trackedSenders) {
          if (sender.track !== track || track.readyState !== 'live') continue;
          registerCapture(track);
          attach(sender, track);
        }
      });
    }
  });
  window.addEventListener('sona-audio-state-request', publishState);
  window.dispatchEvent(new CustomEvent('sona-audio-config-request'));
  window.addEventListener('pagehide', () => {
    pageClosing = true;
    window.dispatchEvent(new CustomEvent('sona-audio-state', { detail: { phase: 'closed' } }));
    for (const session of [...new Set(senders.values())]) void fallbackOutgoing(session, 'Page hidden');
  });
})();
