const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const closerCode = fs.readFileSync(path.join(__dirname, '../src/xcally-popup-closer.js'), 'utf8');
const suppressionCode = fs.readFileSync(path.join(__dirname, '../src/noise-suppression.js'), 'utf8');
const filterCode = fs.readFileSync(path.join(__dirname, '../src/noise-voice-filter.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function createEnvironment({ autoClosePopup = true, noiseSuppression = true, includeNoiseSuppression = true } = {}) {
  const logs = [];
  const warnings = [];
  const mutationCallbacks = [];

  class MockElement extends EventTarget {
    constructor(tagName, attributes = {}) {
      super();
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map(Object.entries(attributes));
      this.children = [];
      this.parentElement = null;
      this.isConnected = false;
      this.textContent = '';
      this.clicked = 0;
      this.angularScope = null;
      this.classList = {
        _set: new Set(),
        add: (...names) => names.forEach(n => this.classList._set.add(n)),
        contains: name => this.classList._set.has(name)
      };
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      for (const grandChild of child.children || []) grandChild.isConnected = this.isConnected;
      this.children.push(child);
      if (this.isConnected) {
        for (const cb of mutationCallbacks) {
          cb([{ addedNodes: [child], removedNodes: [] }]);
        }
      }
      return child;
    }
    remove() {
      this.isConnected = false;
      for (const child of this.children) child.isConnected = false;
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      }
      for (const cb of mutationCallbacks) {
        cb([{ addedNodes: [], removedNodes: [this] }]);
      }
    }
    closest(selector) {
      if (selector.includes('md-tab-item') && this.parentElement?.tagName === 'MD-TAB-ITEM') {
        return this.parentElement;
      }
      return this.parentElement;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const results = [];
      const visit = node => {
        for (const child of node.children || []) {
          if (matchesSelector(child, selector)) results.push(child);
          visit(child);
        }
      };
      visit(this);
      return results;
    }
    click() {
      this.clicked++;
      this.dispatchEvent(new Event('click'));
      if (this.parentElement) this.parentElement.remove();
      else this.remove();
    }
  }

  function matchesSelector(el, selector) {
    if (selector.includes('md-icon[md-font-icon="icon-close-circle-outline"]')) {
      return el.tagName === 'MD-ICON' && el.getAttribute('md-font-icon') === 'icon-close-circle-outline';
    }
    if (selector.includes('button[aria-label="close"]')) {
      const ngClick = el.getAttribute('ng-click') || el.getAttribute('data-ng-click') || '';
      return el.tagName === 'BUTTON' && el.getAttribute('aria-label') === 'close' && ngClick.includes('closeTab');
    }
    if (selector === 'button') return el.tagName === 'BUTTON';
    return false;
  }

  const documentElement = new MockElement('html');
  documentElement.isConnected = true;
  const body = new MockElement('body');
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    querySelectorAll: selector => documentElement.querySelectorAll(selector)
  };

  function createPopupTab({ phone = '233245453445', tabScope = null, active = false } = {}) {
    const tabItem = new MockElement('md-tab-item');
    tabItem.textContent = phone;
    if (active) tabItem.classList.add('md-active');

    const button = new MockElement('button', {
      'aria-label': 'close',
      'ng-click': 'vm.closeTab(tab); $event.stopPropagation()'
    });
    button.angularScope = { tab: tabScope || { title: phone, phone } };

    const icon = new MockElement('md-icon', {
      'md-font-icon': 'icon-close-circle-outline'
    });
    button.appendChild(icon);
    tabItem.appendChild(button);
    return { tabItem, button };
  }

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      mutationCallbacks.push(this.callback);
    }
    disconnect() {}
  }

  class Track extends EventTarget {
    constructor(kind = 'audio') {
      super();
      this.kind = kind;
      this._enabled = true;
      this.readyState = 'live';
    }
    get enabled() { return this._enabled; }
    set enabled(value) { this._enabled = Boolean(value); }
    stop() { this.readyState = 'ended'; }
    clone() { return new Track(this.kind); }
    applyConstraints() { return Promise.resolve(); }
  }

  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    clone() { return new Stream(this.tracks.map(t => t.clone())); }
  }

  class Node {
    connect(node) { return node; }
    disconnect() {}
  }

  class Context {
    constructor() {
      this.state = 'running';
      this.destination = new Node();
      this.audioWorklet = { addModule: async () => {} };
    }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return new Node(); }
    createMediaStreamDestination() {
      const node = new Node();
      node.stream = new Stream([new Track()]);
      return node;
    }
    createBiquadFilter() { return { connect: n => n, disconnect() {}, frequency: {}, Q: {} }; }
    createWaveShaper() { return new Node(); }
  }

  class Worklet extends Node {
    constructor() {
      super();
      this.port = { postMessage() {} };
      queueMicrotask(() => this.port.onmessage?.({ data: { type: 'ready' } }));
    }
  }

  class Sender {
    constructor(track) { this.track = track; }
    replaceTrack(track) { this.track = track; return Promise.resolve(); }
  }

  class PeerConnection extends EventTarget {
    constructor() {
      super();
      this.senders = [];
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.signalingState = 'stable';
    }
    addTrack(track) {
      const sender = new Sender(track);
      this.senders.push(sender);
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
      return sender;
    }
    addTransceiver(trackOrKind) {
      const track = typeof trackOrKind === 'object' ? trackOrKind : new Track(trackOrKind);
      return { sender: this.addTrack(track) };
    }
    getSenders() { return [...this.senders]; }
    removeTrack(sender) {
      this.senders = this.senders.filter(s => s !== sender);
      sender.track = null;
    }
    close() {
      this.connectionState = 'closed';
      this.signalingState = 'closed';
    }
  }

  const window = new EventTarget();
  window.top = window;
  window.location = { origin: 'https://52.49.51.30' };
  window.RTCPeerConnection = PeerConnection;
  window.RTCRtpSender = Sender;
  window.angular = {
    element(el) {
      return {
        scope: () => el.angularScope,
        isolateScope: () => el.angularScope
      };
    }
  };

  class CustomEvent extends Event {
    constructor(name, options) {
      super(name);
      this.detail = options?.detail;
    }
  }

  const navigator = {
    mediaDevices: {
      getUserMedia: async constraints => new Stream(constraints?.audio ? [new Track()] : [])
    }
  };

  const sandbox = {
    window,
    document,
    navigator,
    MutationObserver,
    CustomEvent,
    Event,
    MediaStream: Stream,
    MediaStreamTrack: Track,
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    WebAssembly,
    Uint8Array,
    console: {
      info: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
      warn: (...args) => warnings.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    },
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };

  const scriptToRun = includeNoiseSuppression
    ? `${filterCode}\n${suppressionCode}\n${closerCode}`
    : closerCode;
  vm.runInNewContext(scriptToRun, sandbox);

  const baseUrl = 'chrome-extension://' + 'a'.repeat(32) + '/vendor/rnnoise/';
  window.dispatchEvent(new CustomEvent('sona-audio-config', {
    detail: { enabled: noiseSuppression, autoClosePopup, baseUrl }
  }));

  return {
    window,
    document,
    body,
    navigator,
    PeerConnection,
    CustomEvent,
    createPopupTab,
    logs,
    warnings,
    baseUrl
  };
}

test('auto-closes the customer popup when the agent ends the call (pc.close)', async () => {
  const env = createEnvironment();
  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  const { tabItem, button } = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tabItem);

  assert.equal(button.clicked, 0);
  pc.close();
  assert.equal(button.clicked, 1);
  assert.equal(button.isConnected, false);
});

test('auto-closes the customer popup when the customer hangs up remotely (connectionstatechange -> closed)', async () => {
  const env = createEnvironment();
  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  const { tabItem, button } = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tabItem);

  // Simulate customer-initiated hangup via WebRTC state transition without calling pc.close()
  pc.connectionState = 'closed';
  pc.dispatchEvent(new Event('connectionstatechange'));

  assert.equal(button.clicked, 1);
  raw.stop();
});

test('auto-closes popup when customer hangup triggers media track ended event', async () => {
  const env = createEnvironment();
  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  const { tabItem, button } = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tabItem);

  raw.readyState = 'ended';
  raw.dispatchEvent(new Event('ended'));

  assert.equal(button.clicked, 1);
  pc.close();
});

test('protects unrelated tabs when a call ends without opening or matching any popup', async () => {
  const env = createEnvironment();

  const tab1 = env.createPopupTab({ phone: '233244441268' });
  const tab2 = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tab1.tabItem);
  env.body.appendChild(tab2.tabItem);

  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  pc.close();
  raw.stop();

  assert.equal(tab1.button.clicked, 0);
  assert.equal(tab2.button.clicked, 0);
});

test('auto-closes popup opened on ringing before WebRTC audio connects', async () => {
  const env = createEnvironment();

  // Popup opens while phone is ringing (before getUserMedia / addTrack)
  const { tabItem, button } = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tabItem);

  // Agent answers the call
  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  // Call ends via track ending
  raw.stop();
  assert.equal(button.clicked, 1);
});

test('supports multiple popup tabs and only closes the tab belonging to the ended call', async () => {
  const env = createEnvironment();

  // Earlier/unrelated tab already open (e.g. 233244441268 from screenshot)
  const existingTab = env.createPopupTab({ phone: '233244441268' });
  env.body.appendChild(existingTab.tabItem);

  // New call starts and opens popup for 233245453445
  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  const currentCallTab = env.createPopupTab({ phone: '233245453445', active: true });
  env.body.appendChild(currentCallTab.tabItem);

  // Call ends
  pc.close();
  raw.stop();

  assert.equal(currentCallTab.button.clicked, 1, 'Expected current call popup to be closed');
  assert.equal(existingTab.button.clicked, 0, 'Expected unrelated popup tab to remain open');
  assert.equal(existingTab.button.isConnected, true);
});

test('matches the specific tab by phone number when multiple pre-existing tabs are open', async () => {
  const env = createEnvironment();

  const tab1 = env.createPopupTab({ phone: '233244441268' });
  const tab2 = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tab1.tabItem);
  env.body.appendChild(tab2.tabItem);

  env.window.dispatchEvent(new env.CustomEvent('sona-call-started', {
    detail: { phone: '233245453445' }
  }));
  env.window.dispatchEvent(new env.CustomEvent('sona-call-ended', {
    detail: { phone: '233245453445' }
  }));

  assert.equal(tab1.button.clicked, 0);
  assert.equal(tab2.button.clicked, 1);
});

test('does not close popups when Auto-close call popup setting is disabled by user', async () => {
  const env = createEnvironment({ autoClosePopup: false });

  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  const { tabItem, button } = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tabItem);

  pc.close();
  raw.stop();

  assert.equal(button.clicked, 0, 'Popup should stay open when feature is disabled');

  // Re-enable setting for the next call
  env.window.dispatchEvent(new env.CustomEvent('sona-audio-config', {
    detail: { enabled: true, autoClosePopup: true, baseUrl: env.baseUrl }
  }));

  const stream2 = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw2 = stream2.getAudioTracks()[0];
  const pc2 = new env.PeerConnection();
  pc2.addTrack(raw2, stream2);

  const tab2 = env.createPopupTab({ phone: '233249999999' });
  env.body.appendChild(tab2.tabItem);

  pc2.close();
  assert.equal(tab2.button.clicked, 1, 'Popup for new call should close once setting is enabled');
});

test('toggling noise suppression mid-call does not falsely close the customer popup', async () => {
  const env = createEnvironment({ autoClosePopup: true, noiseSuppression: true });

  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);
  await tick();

  const { tabItem, button } = env.createPopupTab({ phone: '233245453445' });
  env.body.appendChild(tabItem);

  // User toggles noise suppression off during an active call
  env.window.dispatchEvent(new env.CustomEvent('sona-audio-config', {
    detail: { enabled: false, autoClosePopup: true, baseUrl: env.baseUrl }
  }));
  await tick();

  assert.equal(button.clicked, 0, 'Toggling noise suppression must not close the active call popup');

  // Now the call actually ends
  pc.close();
  assert.equal(button.clicked, 1, 'Ending the call closes the popup');
});

test('closes the active customer popup tab when multiple tabs were already open before the call started', async () => {
  const env = createEnvironment();

  const inactiveTab = env.createPopupTab({ phone: '233531183905', active: false });
  const activeTab = env.createPopupTab({ phone: '233543720138', active: true });
  env.body.appendChild(inactiveTab.tabItem);
  env.body.appendChild(activeTab.tabItem);

  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  pc.close();
  raw.stop();

  assert.equal(activeTab.button.clicked, 1, 'Active customer popup tab should close');
  assert.equal(inactiveTab.button.clicked, 0, 'Inactive customer popup tab should remain open');
});

test('closes a single open customer popup tab even if opened before call start', async () => {
  const env = createEnvironment();

  const singleTab = env.createPopupTab({ phone: '233543720138', active: false });
  env.body.appendChild(singleTab.tabItem);

  const stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
  const raw = stream.getAudioTracks()[0];
  const pc = new env.PeerConnection();
  pc.addTrack(raw, stream);

  pc.close();
  raw.stop();

  assert.equal(singleTab.button.clicked, 1, 'Single open popup tab should close when call ends');
});

