const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../src/incoming-audio.js'), 'utf8');
const filters = fs.readFileSync(path.join(__dirname, '../src/noise-voice-filter.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const baseUrl = 'chrome-extension://' + 'a'.repeat(32) + '/vendor/rnnoise/';

function setup({ incomingEnabled = true, failWorklet = false } = {}) {
  class Track extends EventTarget {
    constructor(kind = 'audio') { super(); this.kind = kind; this.readyState = 'live'; }
    stop() { this.readyState = 'ended'; }
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
  }
  class MediaElement extends EventTarget {
    constructor() { super(); this.paused = true; this.muted = false; this._srcObject = null; }
    get srcObject() { return this._srcObject; }
    set srcObject(value) { this._srcObject = value; this.paused = true; } // load() pauses
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class AudioElement extends MediaElement {}
  const players = [];
  function Audio() { const player = new AudioElement(); players.push(player); return player; }
  class Node {
    constructor() { this.connections = []; }
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.connections = []; }
  }
  const contexts = [];
  class Context {
    constructor() {
      contexts.push(this);
      this.state = 'running';
      this.audioWorklet = { addModule: async () => { if (failWorklet) throw Error('CSP'); } };
    }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource(stream) { const node = new Node(); node.stream = stream; return node; }
    createMediaStreamDestination() { const node = new Node(); node.stream = new Stream([new Track()]); return node; }
    createBiquadFilter() { const node = new Node(); node.frequency = {}; node.Q = {}; return node; }
    createWaveShaper() { return new Node(); }
    createGain() { const node = new Node(); node.gain = { value: 1, setValueAtTime() {} }; return node; }
    createDynamicsCompressor() {
      const param = () => ({ value: 0, setValueAtTime() {} });
      return Object.assign(new Node(), {
        threshold: param(), knee: param(), ratio: param(), attack: param(), release: param()
      });
    }
  }
  class Worklet extends Node {
    constructor() {
      super();
      this.port = { postMessage() {} };
      queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } }));
    }
  }
  class PeerConnection extends EventTarget {
    constructor() { super(); this.receivers = []; }
    receive(track) {
      this.receivers.push({ track });
      const event = new Event('track');
      event.track = track;
      this.dispatchEvent(event);
    }
    getReceivers() { return [...this.receivers]; }
    close() { this.closed = true; }
  }
  const window = new EventTarget();
  window.RTCPeerConnection = PeerConnection;
  window.HTMLMediaElement = MediaElement;
  window.AudioContext = Context;
  class CustomEvent extends Event { constructor(name, options) { super(name); this.detail = options?.detail; } }
  const warnings = [];
  vm.runInNewContext(filters + '\n' + code, {
    window, CustomEvent, Event, MediaStream: Stream, Audio,
    AudioContext: Context, AudioWorkletNode: Worklet, WebAssembly, Uint8Array,
    console: { info() {}, warn: (...args) => warnings.push(args.join(' ')) },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    setTimeout, clearTimeout, setInterval, clearInterval
  });
  const configure = enabled => window.dispatchEvent(new CustomEvent('sona-audio-config', {
    detail: { enabled: true, incomingEnabled: enabled, baseUrl }
  }));
  configure(incomingEnabled);

  // A call: the page creates a peer connection, receives the customer's track, plays it.
  function call() {
    const pc = new window.RTCPeerConnection();
    const customer = new Track();
    pc.receive(customer);
    const stream = new Stream([customer]);
    const el = new AudioElement();
    el.srcObject = stream;
    void el.play();
    return { pc, customer, stream, el };
  }
  return { window, Track, Stream, AudioElement, contexts, players, warnings, configure, call };
}

test('customer is audible at once, then switches to processed audio once RNNoise is ready', async () => {
  const s = setup();
  const { el, stream } = s.call();
  assert.equal(el._srcObject, stream, 'original plays before processing is ready');
  await settle();
  assert.notEqual(el._srcObject, stream, 'element now plays the processed stream');
  assert.equal(el.srcObject, stream, 'page still sees the stream it assigned');
  assert.equal(el.paused, false, 'playback resumes after the swap');
  const keeper = s.players[0];
  assert.equal(keeper._srcObject, stream, 'muted keeper keeps remote audio flowing into Web Audio');
  assert.equal(keeper.muted, true);
});

test('does nothing while the beta setting is off', async () => {
  const s = setup({ incomingEnabled: false });
  const { el, stream } = s.call();
  await settle();
  assert.equal(el._srcObject, stream);
  assert.equal(s.contexts.length, 0);
});

test('ignores local streams such as a microphone preview', async () => {
  const s = setup();
  const el = new s.AudioElement();
  const local = new s.Stream([new s.Track()]);
  el.srcObject = local;
  await settle();
  assert.equal(el._srcObject, local);
  assert.equal(s.contexts.length, 0);
});

test('skips streams that carry video to avoid a visible reload', async () => {
  const s = setup();
  const pc = new s.window.RTCPeerConnection();
  const audio = new s.Track();
  pc.receive(audio);
  const el = new s.AudioElement();
  const stream = new s.Stream([audio, new s.Track('video')]);
  el.srcObject = stream;
  await settle();
  assert.equal(el._srcObject, stream);
  assert.equal(s.contexts.length, 0);
});

test('worklet failure keeps the original customer audio and does not retry the same stream', async () => {
  const s = setup({ failWorklet: true });
  const { el, stream } = s.call();
  await settle();
  assert.equal(el._srcObject, stream);
  assert.equal(s.contexts[0].state, 'closed');
  assert.ok(s.warnings.some(line => line.includes('Using original customer audio')));
  s.configure(true);
  await settle();
  assert.equal(s.contexts.length, 1, 'no retry loop on a failed stream');
});

test('turning the setting off mid-call restores the original and on again re-processes', async () => {
  const s = setup();
  const { el, stream } = s.call();
  await settle();
  assert.notEqual(el._srcObject, stream);
  s.configure(false);
  assert.equal(el._srcObject, stream);
  assert.equal(el.paused, false);
  assert.equal(s.contexts[0].state, 'closed');
  s.configure(true);
  await settle();
  assert.notEqual(el._srcObject, stream);
  assert.equal(s.contexts.length, 2);
});

test('releases processing when the page clears the element or the customer hangs up', async () => {
  const s = setup();
  const first = s.call();
  await settle();
  first.el.srcObject = null;
  assert.equal(first.el._srcObject, null);
  assert.equal(s.contexts[0].state, 'closed');

  const second = s.call();
  await settle();
  second.customer.end();
  assert.equal(second.el._srcObject, second.stream);
  assert.equal(s.contexts[1].state, 'closed');
});

test('the customer leveler returns a single connectable node', () => {
  const s = setup();
  const context = new s.window.AudioContext();
  const sandbox = { context };
  vm.runInNewContext(filters + '\nresult = SonaVoiceFilter.createCustomerLeveler(context);', sandbox);
  assert.equal(typeof sandbox.result.connect, 'function');
});
