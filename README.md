# Sona microphone noise cancellation

This release filters the agent's microphone during WebRTC calls on the sites listed in `src/manifest.json`. Customer playback is not intercepted or processed. Audio stays on the agent's computer.

## Build and install

Run `npm run build` in this folder. In `chrome://extensions`, remove or disable the older Sona extension. Enable Developer mode, choose **Load unpacked**, and select this folder's `dist` directory. Reload the calling tab before starting a new call. There is one switch in the popup, **Noise cancellation**.

The call site requests microphone permission; Sona does not request it during installation. When filtering is enabled, the call starts with the original microphone, then switches to the filtered track when the local RNNoise processor is ready. If processing fails, Sona restores the original microphone and requests browser noise suppression where supported.

## Verification

Run `npm test` for microphone lifecycle tests. The optional browser test is `python3 tests/browser-audio.py /path/to/chrome`; it needs Python's `websockets` package and runs a fake-microphone call for one minute plus ten repeated calls. It checks that customer playback remains untouched and audio contexts close.

Before team rollout, test with agents for a full shift on the actual call platform. Confirm that customers hear the agents clearly during long and repeated calls, and check mute, hold, and headset changes.
