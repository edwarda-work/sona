# Microphone-only architecture

Sona runs only on browser call sites listed in `src/manifest.json`. The first supported sites are the agent call platform and Google Meet. The same sites must appear in both content script entries and the audio asset entry; `build.mjs` checks this.

The isolated-world bridge reads the user's switch setting and supplies the packaged worklet URL. The main-world script observes microphone capture and WebRTC senders. The browser's original microphone track remains live while RNNoise runs in a local AudioWorklet. Sona switches the sender to the processed track only after the worklet reports readiness.

Each captured track owns one processing session. A session owns its audio context, worklet, output track, senders, and health timer. Multiple senders using the same captured track share that session. Track stop, sender removal, peer connection close, page exit, and disabling Sona release the session. A failing session restores its sender to the original track and asks the browser to enable native noise suppression where supported.

The extension does not intercept remote tracks, speakers, media elements, or network audio. It does not upload microphone audio.

## Session transitions

1. **Captured:** Return the original microphone to the call site immediately.
2. **Starting:** Load the packaged model and worklet; the original microphone remains attached.
3. **Filtering:** Attach the processed track after readiness; follow the original track's mute state.
4. **Fallback:** On failure or disable, wait for pending track switches, restore the original track, then close the processing graph.
5. **Closed:** Release all owned audio resources. A later enable may create a new session for a still-live original track.

## Release gate

Unit tests cover startup, fallback, live switching, mute, repeated calls, and untouched incoming playback. The Chrome smoke test checks a one-minute WebRTC call and ten more calls with a fake microphone. Real Google Meet and call-platform pilots must still cover long sessions, mute, device changes, and speech quality before merging a development release into `main`.

The main-world script reports state changes through the isolated bridge. The background worker stores each frame's current phase for its tab and removes it when the frame closes or the tab navigates. The popup reads these phases and gives fallback precedence over filtering so a partial failure is visible. No audio or transcript is stored.
