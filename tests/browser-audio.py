"""Smoke test the production audio scripts with Chrome's fake microphone and local WebRTC.

Run: python3 tests/browser-audio.py /path/to/chrome
Requires the Python websockets package. No real microphone is accessed.
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


async def verify(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/json') as response:
        tab = next(item for item in json.load(response) if item['type'] == 'page')
    async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=2**24) as ws:
        await ws.send(json.dumps({
            'id': 1, 'method': 'Runtime.evaluate',
            'params': {
                'expression': '''(async () => {
                  const logs = [];
                  const warnings = [];
                  const originalInfo = console.info;
                  const originalWarn = console.warn;
                  console.info = (...args) => { logs.push(args.join(' ')); originalInfo(...args); };
                  console.warn = (...args) => { warnings.push(args.join(' ')); originalWarn(...args); };
                  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
                  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  const raw = stream.getAudioTracks()[0];
                  const caller = new RTCPeerConnection();
                  const receiver = new RTCPeerConnection();
                  caller.onicecandidate = ({ candidate }) => {
                    if (candidate) receiver.addIceCandidate(candidate).catch(() => {});
                  };
                  receiver.onicecandidate = ({ candidate }) => {
                    if (candidate) caller.addIceCandidate(candidate).catch(() => {});
                  };
                  const incoming = new Promise(resolve => { receiver.ontrack = event => resolve(event.track); });
                  const sender = caller.addTrack(raw, stream);
                  const startedRaw = sender.track === raw;
                  await caller.setLocalDescription(await caller.createOffer());
                  await receiver.setRemoteDescription(caller.localDescription);
                  await receiver.setLocalDescription(await receiver.createAnswer());
                  await caller.setRemoteDescription(receiver.localDescription);
                  const remote = await incoming;
                  for (let i = 0; i < 40 && sender.track === raw; i++) await wait(100);
                  const upgraded = sender.track !== raw;
                  const playback = new Audio();
                  const remoteStream = new MediaStream([remote]);
                  playback.srcObject = remoteStream;
                  await playback.play();
                  const originalPlaybackStream = playback.srcObject === remoteStream;
                  const customerPlaybackUntouched = window.__players.length === 1 && !playback.muted;
                  await wait(60000); // Exercise a sustained call, well past the watchdog interval.
                  const stillProcessed = sender.track !== raw;
                  const customerPlaybackStillUntouched = playback.srcObject === remoteStream &&
                    window.__players.length === 1 && !playback.muted;
                  const context = new AudioContext();
                  await context.resume();
                  const analyser = context.createAnalyser();
                  context.createMediaStreamSource(remoteStream).connect(analyser);
                  const samples = new Float32Array(analyser.fftSize);
                  let remotePeak = 0;
                  for (let i = 0; i < 20; i++) {
                    await wait(100);
                    analyser.getFloatTimeDomainData(samples);
                    for (const sample of samples) remotePeak = Math.max(remotePeak, Math.abs(sample));
                  }
                  playback.srcObject = null;
                  caller.close();
                  receiver.close();
                  raw.stop();
                  await context.close();
                  let repeatedUpgrades = 0;
                  for (let call = 0; call < 10; call++) {
                    const next = await navigator.mediaDevices.getUserMedia({ audio: true });
                    const nextRaw = next.getAudioTracks()[0];
                    const nextConnection = new RTCPeerConnection();
                    const nextSender = nextConnection.addTrack(nextRaw, next);
                    for (let i = 0; i < 40 && nextSender.track === nextRaw; i++) await wait(100);
                    if (nextSender.track !== nextRaw) repeatedUpgrades++;
                    nextConnection.close();
                    nextRaw.stop();
                  }
                  await wait(100);
                  const allClosed = window.__audioContexts.every(item => item.state === 'closed');
                  return { startedRaw, upgraded, originalPlaybackStream, customerPlaybackUntouched,
                    customerPlaybackStillUntouched,
                    stillProcessed, repeatedUpgrades, allClosed,
                    contextCount: window.__audioContexts.length, remotePeak, warnings, logs };
                })()''',
                'awaitPromise': True, 'returnByValue': True, 'userGesture': True
            }
        }))
        while True:
            message = json.loads(await ws.recv())
            if message.get('id') == 1:
                break
        if 'error' in message or 'exceptionDetails' in message.get('result', {}):
            raise RuntimeError(message)
        value = message['result']['result']['value']
        print(json.dumps(value, indent=2))
        assert value['startedRaw'], 'The call did not begin with the original microphone'
        assert value['upgraded'], 'Outgoing RNNoise did not become active'
        assert value['originalPlaybackStream'], 'The softphone playback stream was replaced'
        assert value['customerPlaybackUntouched'], 'Customer playback was changed'
        assert value['customerPlaybackStillUntouched'], 'Customer playback changed during the call'
        assert value['stillProcessed'], 'RNNoise failed or stalled during the call'
        assert value['repeatedUpgrades'] == 10, 'A later call did not activate RNNoise'
        assert value['allClosed'], 'Audio contexts remained open after both calls'
        assert not value['warnings'], 'Audio processing logged a fallback during the endurance test'
        assert value['remotePeak'] > 0.00001, 'The received audio was silent'


def main():
    with tempfile.TemporaryDirectory(prefix='fido-audio-test-') as directory:
        temp = Path(directory)
        shutil.copy(ROOT / 'src/noise-voice-filter.js', temp)
        shutil.copytree(ROOT / 'src/vendor', temp / 'vendor')
        source = (ROOT / 'src/noise-suppression.js').read_text()
        extension_check = r'!/^chrome-extension:\/\/[a-p]{32}\/vendor\/rnnoise\/$/.test(detail.baseUrl)'
        assert source.count(extension_check) == 1
        source = source.replace(extension_check,
                                "!detail.baseUrl.startsWith(location.origin + '/vendor/rnnoise/')")
        (temp / 'noise-suppression.js').write_text(source)
        (temp / 'index.html').write_text('''<!doctype html><title>Fido audio integration test</title>
          <script>
            window.__audioContexts = [];
            const NativeAudioContext = window.AudioContext;
            window.AudioContext = class extends NativeAudioContext {
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
          <script>
            window.dispatchEvent(new CustomEvent('sona-audio-config', {
              detail: { enabled: true, baseUrl: location.origin + '/vendor/rnnoise/' }
            }));
          </script>''')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        profile = temp / 'profile'
        log = (temp / 'chrome.log').open('w')
        process = subprocess.Popen([
            sys.argv[1], '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--remote-debugging-port=0', '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
            f'--user-data-dir={profile}', f'http://127.0.0.1:{server.server_port}/'
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
            process.terminate()
            process.wait(timeout=10)
            server.shutdown()
            log.close()


if __name__ == '__main__':
    main()
