// Noise gate / downward expander running on the audio thread.
// Quiet background hiss below the threshold is attenuated smoothly.
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -60, minValue: -100, maxValue: 0 }, // dBFS
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.env = 0;      // envelope follower (linear)
    this.gain = 1;     // current gate gain
    const sr = sampleRate;
    this.envAttack = Math.exp(-1 / (0.002 * sr));
    this.envRelease = Math.exp(-1 / (0.050 * sr));
    this.gateOpen = Math.exp(-1 / (0.005 * sr));
    this.gateClose = Math.exp(-1 / (0.120 * sr));
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const enabled = params.enabled[0] >= 0.5;
    const thr = Math.pow(10, params.threshold[0] / 20);
    const n = input[0].length;

    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const v = Math.abs(input[c][i]);
        if (v > peak) peak = v;
      }
      const coef = peak > this.env ? this.envAttack : this.envRelease;
      this.env = coef * this.env + (1 - coef) * peak;

      let target = 1;
      if (enabled && this.env < thr) {
        // 4:1 downward expansion, floor at -40 dB
        const ratio = this.env / thr;
        target = Math.max(0.01, ratio * ratio * ratio);
      }
      const gc = target > this.gain ? this.gateOpen : this.gateClose;
      this.gain = gc * this.gain + (1 - gc) * target;

      for (let c = 0; c < output.length; c++) {
        const src = input[c] || input[0];
        output[c][i] = src[i] * this.gain;
      }
    }
    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
