// AudioWorklet: microphone -> fixed-size Float32 blocks on the message port.
//
// Loaded by src/lib/deepgramMic.ts via `?url`, so it ships as a same-origin
// asset. It used to be a Blob URL, which works today but would break the moment
// netlify.toml's Content-Security-Policy is promoted out of Report-Only:
// worklet scripts are governed by `script-src`, and that directive is
// `'self' 'unsafe-inline'` with no `blob:`. A real file needs no exception.
//
// NOT bundled or transpiled (`?url` emits it verbatim), so keep it to syntax
// every browser that can run a huddle already understands, and keep it free of
// imports.

// 512 samples at 16kHz is 32ms, and that number is a latency budget, not a
// buffer size: a sample sits here until the block is full, so the LAST word of
// an utterance waits up to one block before Deepgram has even seen it, and
// end-of-turn cannot be declared until it has. This was 1024 (64ms); halving it
// halves that wait, and 32ms sits inside Deepgram's recommended 20-50ms band
// where 64ms did not. The cost is 31 port messages a second instead of 15, which
// is nothing next to the audio itself.
//
// Do not raise it back without measuring: the whole end-of-turn stage costs
// 86-110ms (measured against live Flux, 2026-07-26), so 32ms of local buffering
// is a THIRD of it — the largest remaining slice of the fastest stage.
const FRAMES_PER_POST = 512;

class AgensisPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAMES_PER_POST);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet is normal on the first render quanta; returning false here
    // would end the processor permanently.
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.buffer.length - this.filled);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.buffer.length) {
        // A copy, transferred: the worklet reuses `this.buffer` every quantum,
        // so posting it directly would hand the main thread memory that is
        // about to be overwritten mid-read.
        const out = this.buffer.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('agensis-pcm-tap', AgensisPcmTap);
