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

// 1024 samples at 16kHz is 64ms — small enough that Deepgram Flux sees speech
// promptly, large enough that we are not crossing the worklet boundary a
// hundred times a second. Must match FRAMES_PER_POST in deepgramMic.ts.
const FRAMES_PER_POST = 1024;

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
