// Shared by the call pipeline and the listening demo. No gate: quiet speech
// must not be cut off just because it falls below a fixed volume threshold.
const SonaVoiceFilter = (() => {
  const curve = new Float32Array(8193);
  for (let i = 0; i < curve.length; i++) {
    const x = 2 * i / (curve.length - 1) - 1;
    const magnitude = Math.abs(x);
    // Unity below 0.8; progressively round louder peaks without boosting noise.
    const limited = magnitude <= 0.8 ? magnitude :
      0.8 + 0.19 * (1 - Math.exp(-(magnitude - 0.8) / 0.19));
    curve[i] = Math.sign(x) * limited;
  }

  return Object.freeze({
    createRumbleFilter(context) {
      const filter = context.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 80;
      // High/low-pass Q is specified in dB by Web Audio. Butterworth response.
      filter.Q.value = 20 * Math.log10(Math.SQRT1_2);
      return filter;
    },
    createPeakLimiter(context) {
      const limiter = context.createWaveShaper();
      limiter.curve = curve;
      // No look-ahead delay. Out-of-range samples use the bounded curve ends.
      limiter.oversample = 'none';
      return limiter;
    }
  });
})();
