"""Smoke test incoming customer-audio processing in real Chrome.

Run: python3 tests/browser-incoming.py /path/to/chrome
Requires the Python websockets package. Uses Chrome's fake microphone and a local
WebRTC loopback call; no real microphone or network is used. The outgoing and
incoming scripts are loaded together, as in the extension.
"""
import asyncio
import functools
import http.server
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import websockets

ROOT = Path(__file__).resolve().parent.parent
SPEECH = False  # set in main() when macOS `say` can generate a speech sample
EXTENSION_CHECK = r'!/^chrome-extension:\/\/[a-p]{32}\/vendor\/rnnoise\/$/.test(detail.baseUrl)'

PAGE_TEST = '''(async () => {
  const warnings = window.__warnings = [], logs = window.__logs = [];
  const step = name => { window.__step = name; };
  const origWarn = console.warn, origInfo = console.info;
  console.warn = (...a) => { warnings.push(a.join(' ')); origWarn(...a); };
  console.info = (...a) => { logs.push(a.join(' ')); origInfo(...a); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const native = el => window.__nativeSrc.get.call(el);
  const configure = incomingEnabled => window.dispatchEvent(new CustomEvent('sona-audio-config', {
    detail: { enabled: true, incomingEnabled, baseUrl: location.origin + '/vendor/rnnoise/' } }));

  async function peak(stream, ms = 1500) {
    const ctx = new (window.__NativeAudioContext)();
    await ctx.resume();
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let max = 0;
    for (let i = 0; i < ms / 100; i++) {
      await wait(100);
      analyser.getFloatTimeDomainData(buf);
      for (const s of buf) max = Math.max(max, Math.abs(s));
    }
    await ctx.close();
    return max;
  }

  // Loopback call: "caller" plays the customer (fake mic), "agent" receives it.
  step('getUserMedia');
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const customerSide = new RTCPeerConnection();
  const agentSide = new RTCPeerConnection();
  customerSide.onicecandidate = ({ candidate }) => candidate && agentSide.addIceCandidate(candidate).catch(() => {});
  agentSide.onicecandidate = ({ candidate }) => candidate && customerSide.addIceCandidate(candidate).catch(() => {});
  const incoming = new Promise(r => { agentSide.ontrack = e => r(e.track); });
  customerSide.addTrack(mic.getAudioTracks()[0], mic);
  await customerSide.setLocalDescription(await customerSide.createOffer());
  await agentSide.setRemoteDescription(customerSide.localDescription);
  await agentSide.setLocalDescription(await agentSide.createAnswer());
  await customerSide.setRemoteDescription(agentSide.localDescription);
  step('waiting for remote track');
  const remote = await incoming;
  const remoteStream = new MediaStream([remote]);

  const playback = new Audio();
  playback.srcObject = remoteStream;
  step('play');
  await playback.play();
  const audibleImmediately = native(playback) === remoteStream;

  step('waiting for swap');
  const t0 = performance.now();
  for (let i = 0; i < 50 && native(playback) === remoteStream; i++) await wait(100);
  const switchMs = Math.round(performance.now() - t0);
  const processed = native(playback);
  const swapped = processed !== remoteStream && processed instanceof MediaStream;
  const pageSeesOriginal = playback.srcObject === remoteStream;
  const playingAfterSwap = !playback.paused;
  const keeper = window.__players.find(p => p !== playback);
  const keeperMutedOnOriginal = Boolean(keeper && keeper.muted && native(keeper) === remoteStream);

  step('measuring levels');
  // Measure both over the same stretch of audio so the comparison is fair.
  const [micPeak, originalPeak, processedPeak] = await Promise.all([
    peak(mic, 4000), peak(remoteStream, 4000), swapped ? peak(processed, 4000) : 0]);

  step('sustained call');
  await wait(15000); // well past the 2.5 s heartbeat watchdog
  const stillSwapped = native(playback) === processed;

  step('toggle off/on');
  configure(false);
  await wait(50);
  const offRestored = native(playback) === remoteStream && !playback.paused;
  configure(true);
  for (let i = 0; i < 50 && native(playback) === remoteStream; i++) await wait(100);
  const reEnabled = native(playback) !== remoteStream;

  step('release');
  playback.srcObject = null;
  await wait(300);
  const released = native(playback) === null;
  // Hang up so the outgoing (caller-side) session releases too, then check everything closed.
  customerSide.close(); agentSide.close(); mic.getTracks().forEach(t => t.stop());
  await wait(300);
  const sonaContexts = window.__audioContexts;
  const allClosed = sonaContexts.every(c => c.state === 'closed');

  return { audibleImmediately, swapped, switchMs, pageSeesOriginal, playingAfterSwap,
    keeperMutedOnOriginal, micPeak, originalPeak, processedPeak, stillSwapped, offRestored,
    reEnabled, released, allClosed, contextCount: sonaContexts.length, warnings, logs };
})()'''


async def verify(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/json') as response:
        tab = next(item for item in json.load(response) if item['type'] == 'page')
    async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=2**24) as ws:
        await ws.send(json.dumps({'id': 1, 'method': 'Runtime.evaluate', 'params': {
            'expression': PAGE_TEST, 'awaitPromise': True, 'returnByValue': True, 'userGesture': True}}))
        try:
            while True:
                message = json.loads(await asyncio.wait_for(ws.recv(), timeout=90))
                if message.get('id') == 1:
                    break
        except TimeoutError:
            await ws.send(json.dumps({'id': 2, 'method': 'Runtime.evaluate', 'params': {
                'expression': 'JSON.stringify({step: window.__step, logs: window.__logs, warnings: window.__warnings})',
                'returnByValue': True}}))
            while True:
                debug = json.loads(await ws.recv())
                if debug.get('id') == 2:
                    break
            raise RuntimeError('Page test timed out: ' + debug['result']['result']['value'])
    if 'error' in message or 'exceptionDetails' in message.get('result', {}):
        raise RuntimeError(message)
    value = message['result']['result']['value']
    print(json.dumps(value, indent=2))
    assert value['audibleImmediately'], 'Customer was not audible before processing started'
    assert value['swapped'], 'Playback never switched to processed customer audio'
    assert value['pageSeesOriginal'], 'Page saw a different srcObject than it assigned'
    assert value['playingAfterSwap'], 'Playback paused after the swap'
    assert value['keeperMutedOnOriginal'], 'No muted keep-alive player on the original stream'
    assert value['originalPeak'] > 0.00001, 'The received customer audio was silent'
    assert value['processedPeak'] > 0.00001, 'Processed customer audio was silent'
    if SPEECH:
        # Real speech should survive RNNoise and the leveler at a usable level.
        ratio = value['processedPeak'] / value['originalPeak']
        print(f'processed/original peak ratio: {ratio:.2f}')
        assert ratio > 0.25, 'Speech was suppressed far too much'
    assert value['stillSwapped'], 'Processing fell back during the sustained call'
    assert value['offRestored'], 'Turning the setting off did not restore original audio'
    assert value['reEnabled'], 'Turning the setting back on did not re-process'
    assert value['released'] and value['allClosed'], 'Audio contexts left open after release'
    assert not value['warnings'], 'A fallback was logged during the test'


def main():
    with tempfile.TemporaryDirectory(prefix='sona-incoming-test-') as directory:
        temp = Path(directory)
        shutil.copy(ROOT / 'src/noise-voice-filter.js', temp)
        shutil.copytree(ROOT / 'src/vendor', temp / 'vendor')
        for name in ('noise-suppression.js', 'incoming-audio.js'):
            source = (ROOT / 'src' / name).read_text()
            assert source.count(EXTENSION_CHECK) == 1, name
            (temp / name).write_text(source.replace(
                EXTENSION_CHECK, "!detail.baseUrl.startsWith(location.origin + '/vendor/rnnoise/')"))
        (temp / 'index.html').write_text('''<!doctype html><title>Sona incoming test</title>
          <script>
            window.__nativeSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
            window.__audioContexts = [];
            window.__NativeAudioContext = window.AudioContext;
            window.AudioContext = class extends window.__NativeAudioContext {
              constructor(...args) { super(...args); window.__audioContexts.push(this); }
            };
            window.__players = [];
            const NativeAudio = window.Audio;
            window.Audio = function (...args) {
              const player = new NativeAudio(...args);
              window.__players.push(player);
              return player;
            };
            window.Audio.prototype = NativeAudio.prototype;
          </script>
          <script src="noise-voice-filter.js"></script>
          <script src="noise-suppression.js"></script>
          <script src="incoming-audio.js"></script>
          <script>
            window.dispatchEvent(new CustomEvent('sona-audio-config', { detail: {
              enabled: true, incomingEnabled: true, baseUrl: location.origin + '/vendor/rnnoise/' } }));
          </script>''')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        profile = temp / 'profile'
        log = (temp / 'chrome.log').open('w')
        # The default fake microphone is a pure beep, which RNNoise rightly removes.
        # Use real synthesized speech when available so voice survival is measurable.
        global SPEECH
        extra = []
        speech = temp / 'speech.wav'
        if shutil.which('say'):
            subprocess.run(['say', '-o', str(speech), '--file-format=WAVE', '--data-format=LEI16@48000',
                            'Hello, thanks for calling. Could you please confirm your account number '
                            'and the date of your last payment so I can help you today?'], check=True)
            # macOS sandboxes the audio service away from temp files; without this the
            # fake microphone silently produces nothing.
            extra = [f'--use-file-for-fake-audio-capture={speech}',
                     '--disable-features=AudioServiceSandbox']
            SPEECH = True
        process = subprocess.Popen([
            sys.argv[1], '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--remote-debugging-port=0', '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
            *extra, *__import__('os').environ.get('SONA_CHROME_FLAGS', '').split(), f'--user-data-dir={profile}', f'http://127.0.0.1:{server.server_port}/'
        ], stdout=log, stderr=log)
        try:
            active_port = profile / 'DevToolsActivePort'
            for _ in range(100):
                if active_port.exists():
                    break
                if process.poll() is not None:
                    raise RuntimeError((temp / 'chrome.log').read_text())
                time.sleep(0.1)
            port = int(active_port.read_text().splitlines()[0])
            time.sleep(1)
            asyncio.run(asyncio.wait_for(verify(port), timeout=120))
        finally:
            if __import__('os').environ.get('SONA_DEBUG'): print((temp / 'chrome.log').read_text()[-3000:])
            process.terminate()
            process.wait(timeout=10)
            server.shutdown()
            log.close()


if __name__ == '__main__':
    main()
