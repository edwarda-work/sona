const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../src/noise-suppression.js'), 'utf8');
const filters = fs.readFileSync(path.join(__dirname, '../src/noise-voice-filter.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup({ enabled = true, failWorklet = false, delayProcessedSwitch = false } = {}) {
  class Track extends EventTarget {
    constructor(kind = 'audio') { super(); this.kind = kind; this.enabled = true; this.readyState = 'live'; }
    stop() { this.readyState = 'ended'; }
    clone() { return new Track(this.kind); }
    applyConstraints(constraints) { this.applied = constraints; return Promise.resolve(); }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    clone() { return new Stream(this.tracks.map(track => track.clone())); }
  }
  class MediaElement extends EventTarget {
    constructor() { super(); this.volume = 1; this.paused = false; this._muted = false; this._srcObject = null; this.sinkId = ''; }
    get muted() { return this._muted; }
    set muted(value) { this._muted = Boolean(value); this.dispatchEvent(new Event('volumechange')); }
    get srcObject() { return this._srcObject; }
    set srcObject(value) { this._srcObject = value; }
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    setSinkId(id) { this.sinkId = id; return Promise.resolve(); }
  }
  class AudioElement extends MediaElement {}
  class Node {
    constructor() { this.connections = []; }
    connect(node) { this.connections.push(node); return node; }
    disconnect(node) { this.connections = node ? this.connections.filter(item => item !== node) : []; }
  }
  const contexts = [], worklets = [], players = [], calls = [], warnings = [], pendingSwitches = [];
  class Context {
    constructor() {
      contexts.push(this);
      this.state = 'running'; this.sampleRate = 48000; this.destination = new Node();
      this.audioWorklet = { addModule: async () => { if (failWorklet) throw Error('CSP'); } };
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return new Node(); }
    createMediaStreamDestination() { const node = new Node(); node.stream = new Stream([new Track()]); return node; }
    createBiquadFilter() { const node = new Node(); node.frequency = {}; node.Q = {}; return node; }
    createWaveShaper() { return new Node(); }
  }
  class Worklet extends Node {
    constructor(context) {
      super(); this.context = context; worklets.push(this);
      this.port = { postMessage(message) { if (message === 'destroy') this.destroyed = true; } };
      queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } }));
    }
  }
  class Sender {
    constructor(track) { this.track = track; this.original = track; }
    replaceTrack(track) {
      if (delayProcessedSwitch && track !== this.original) {
        return new Promise(resolve => pendingSwitches.push(() => { this.track = track; resolve(); }));
      }
      this.track = track;
      return Promise.resolve();
    }
  }
  class PeerConnection {
    constructor() { this.senders = []; }
    addTrack(track) { const sender = new Sender(track); this.senders.push(sender); return sender; }
    addTransceiver(track) { return { sender: this.addTrack(track) }; }
    getSenders() { return [...this.senders]; }
    removeTrack(sender) { sender.track = null; }
    close() { this.closed = true; }
  }
  const window = new EventTarget();
  window.RTCPeerConnection = PeerConnection;
  window.RTCRtpSender = Sender;
  class CustomEvent extends Event { constructor(name, options) { super(name); this.detail = options?.detail; } }
  const navigator = { mediaDevices: { getUserMedia: async constraints => {
    calls.push(constraints);
    return new Stream(constraints.audio ? [new Track()] : []);
  } } };
  function Audio() { const player = new AudioElement(); players.push(player); return player; }
  vm.runInNewContext(filters + '\n' + code, {
    navigator, window, CustomEvent, Event, MediaStream: Stream, MediaStreamTrack: Track,
    HTMLMediaElement: MediaElement, HTMLAudioElement: AudioElement, Audio,
    AudioContext: Context, AudioWorkletNode: Worklet, WebAssembly, Uint8Array,
    console: { info() {}, warn: (...args) => warnings.push(args.join(' ')) },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  window.dispatchEvent(new CustomEvent('sona-audio-config', { detail: {
    enabled, baseUrl: 'chrome-extension://' + 'a'.repeat(32) + '/vendor/rnnoise/'
  } }));
  return { navigator, window, CustomEvent, Track, Stream, AudioElement, PeerConnection,
    contexts, worklets, players, calls, warnings, pendingSwitches };
}

test('outgoing call starts on original microphone and upgrades after RNNoise is ready', async () => {
  const s = setup();
  const stream = await s.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new s.PeerConnection();
  const sender = pc.addTrack(raw, stream);
  assert.equal(sender.track, raw);
  await tick();
  assert.notEqual(sender.track, raw);
  assert.equal(raw.readyState, 'live');
  assert.equal(s.calls[0].audio.noiseSuppression, false);
  pc.close();
  assert.equal(s.contexts[0].state, 'closed');
});

test('processor failure returns the sender to the original microphone', async () => {
  const s = setup();
  const raw = (await s.navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
  const pc = new s.PeerConnection();
  const sender = pc.addTrack(raw);
  await tick();
  const processed = sender.track;
  s.worklets[0].onprocessorerror();
  await tick();
  assert.equal(sender.track, raw);
  assert.equal(raw.readyState, 'live');
  assert.equal(processed.readyState, 'ended');
  assert.equal(s.contexts[0].state, 'closed');
  assert.equal(raw.applied.noiseSuppression, true);
});

test('disabling while the processed track is attaching restores the live microphone', async () => {
  const s = setup({ delayProcessedSwitch: true });
  const raw = (await s.navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
  const sender = new s.PeerConnection().addTrack(raw);
  await tick();
  assert.equal(s.pendingSwitches.length, 1);
  s.window.dispatchEvent(new s.CustomEvent('sona-audio-config', { detail: {
    enabled: false, baseUrl: 'chrome-extension://' + 'a'.repeat(32) + '/vendor/rnnoise/'
  } }));
  s.pendingSwitches.shift()();
  await tick();
  assert.equal(sender.track, raw);
  assert.equal(s.contexts[0].state, 'closed');
});

test('fallback preserves mute and recovers when the audio context is interrupted', async () => {
  const s = setup();
  const raw = (await s.navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
  const sender = new s.PeerConnection().addTrack(raw);
  await tick();
  sender.track.enabled = false;
  s.contexts[0].state = 'interrupted';
  s.contexts[0].onstatechange();
  await tick();
  assert.equal(sender.track, raw);
  assert.equal(raw.enabled, false);
  assert.equal(s.contexts[0].state, 'closed');
});

test('repeated calls release every audio context', async () => {
  const s = setup();
  for (let i = 0; i < 4; i++) {
    const raw = (await s.navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
    const pc = new s.PeerConnection();
    pc.addTrack(raw);
    await tick();
    pc.close();
    raw.stop();
  }
  assert.equal(s.contexts.length, 4);
  assert.ok(s.contexts.every(context => context.state === 'closed'));
});

test('worklet setup failure leaves original outgoing audio attached', async () => {
  const s = setup({ failWorklet: true });
  const raw = (await s.navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
  const sender = new s.PeerConnection().addTrack(raw);
  await tick();
  assert.equal(sender.track, raw);
  assert.equal(s.contexts[0].state, 'closed');
});

test('customer playback remains untouched', async () => {
  const s = setup();
  const element = new s.AudioElement();
  const remote = new s.Stream([new s.Track()]);
  element.srcObject = remote;
  await tick();
  assert.equal(element.srcObject, remote);
  assert.equal(s.players.length, 0);
  assert.equal(element.muted, false);
  assert.equal(s.contexts.length, 0);
});

test('disabled suppression uses original capture without any processor', async () => {
  const s = setup({ enabled: false });
  const raw = (await s.navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0];
  const sender = new s.PeerConnection().addTrack(raw);
  await tick();
  assert.equal(sender.track, raw);
  assert.equal(s.contexts.length, 0);
});
