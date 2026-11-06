# Sona microphone noise cancellation

Sona filters the user's microphone during browser calls and meetings on the sites listed in `src/manifest.json`, including the current call platform and Google Meet. Incoming playback is not intercepted or processed. Audio stays on the user's computer. Desktop meeting apps are outside this extension's scope.

## Build and install

Run `npm run build` in this folder. In `chrome://extensions`, remove or disable the older Sona extension. Enable Developer mode, choose **Load unpacked**, and select this folder's `dist` directory. Reload the call or meeting tab. There is one switch in the popup, **Noise cancellation**. The switch can be changed during an active call.

The call site requests microphone permission; Sona does not request it during installation. When filtering is enabled, the call starts with the original microphone, then switches to the filtered track when the local RNNoise processor is ready. If processing fails, Sona restores the original microphone and requests browser noise suppression where supported.

## Verification

Run `npm test` for microphone lifecycle tests. The optional browser test is `python3 tests/browser-audio.py /path/to/chrome`; it needs Python's `websockets` package and runs a fake-microphone call for one minute plus ten repeated calls. It checks that customer playback remains untouched and audio contexts close.

Before team rollout, test with agents for a full shift on the actual call platform and with users in long and repeated Google Meet meetings. Confirm that others hear speech clearly and check mute, hold, headset changes, and switching Sona on and off during a call.
