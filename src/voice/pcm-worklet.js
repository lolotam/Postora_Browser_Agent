import { createPcmResampler } from './pcm-resampler.js';

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const inputRate = options?.processorOptions?.inputRate || sampleRate;
    this.resampler = createPcmResampler(inputRate);
    this.chunkSize = 4096;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const out = this.resampler.push(input);
      if (out.length) {
        // The audio is posted in chunks of at most 4096 samples, and the
        // level of every chunk is reported with it.
        for (let i = 0; i < out.length; i += this.chunkSize) {
          const end = Math.min(i + this.chunkSize, out.length);
          const chunk = out.slice(i, end);
          let sum = 0;
          for (let k = 0; k < chunk.length; k++) sum += chunk[k] * chunk[k];
          const rms = Math.sqrt(sum / (chunk.length || 1));
          // The chunk is a copy: the resampler keeps its own history and
          // never hands it over.
          this.port.postMessage({ type: 'pcm', samples: chunk, rms }, [chunk.buffer]);
        }
      }
    }
    // The output stays silent: this node listens, it does not speak.
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
