// Howl: RNNoise AudioWorklet processor.
//
// Runs Mozilla/Xiph's RNNoise (recurrent neural network denoiser) inside an
// AudioWorklet so mic audio is denoised before it hits the Opus encoder.
// Loaded lazily on voice-join when the user has "Advanced noise suppression"
// enabled in Voice & Video settings.
//
// The WASM binary is inlined (base64) in /rnnoise-sync.js so the worklet can
// bootstrap synchronously — AudioWorkletGlobalScope lacks `fetch`, and
// separately-served .wasm files are awkward to load. The sync bundle is
// ~1.9 MB of lazy-loaded JS — only downloaded when a user actually turns
// the feature on.

import createRNNWasmModuleSync from '/rnnoise-sync.js';

const FRAME_SIZE = 480;        // RNNoise internal frame size at 48 kHz
const SAMPLE_SCALE = 32768;    // RNNoise expects float32 scaled to int16 range

class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this._mod = null;
    this._state = null;
    this._inputPtr = 0;
    this._outputPtr = 0;
    this._inQueue = new Float32Array(FRAME_SIZE);
    this._inQueueLen = 0;
    this._outQueue = [];  // list of 480-sample Float32Array frames
    this._outReadOffset = 0;
    this._disabled = false;
    this._destroyed = false;

    try {
      this._mod = createRNNWasmModuleSync();
      this._state = this._mod._rnnoise_create(0);
      this._inputPtr = this._mod._malloc(FRAME_SIZE * 4);
      this._outputPtr = this._mod._malloc(FRAME_SIZE * 4);
    } catch (err) {
      // If the WASM fails to init, fall back to a pass-through. Don't break
      // the mic — users just get non-denoised audio with a console warn.
      this._disabled = true;
      // eslint-disable-next-line no-console
      console.warn('[rnnoise-worklet] init failed, passing through:', err && err.message);
    }

    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'destroy') this._cleanup();
    };
  }

  _cleanup() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      if (this._mod && this._state) this._mod._rnnoise_destroy(this._state);
      if (this._mod && this._inputPtr) this._mod._free(this._inputPtr);
      if (this._mod && this._outputPtr) this._mod._free(this._outputPtr);
    } catch { /* ignore cleanup errors */ }
    this._mod = null;
    this._state = null;
    this._inputPtr = 0;
    this._outputPtr = 0;
  }

  _processFrame() {
    // Scale float [-1, 1] to RNNoise's int16 range in-place on the WASM heap.
    const heap = this._mod.HEAPF32;
    const inOffset = this._inputPtr >> 2;
    for (let i = 0; i < FRAME_SIZE; i++) heap[inOffset + i] = this._inQueue[i] * SAMPLE_SCALE;
    this._mod._rnnoise_process_frame(this._state, this._outputPtr, this._inputPtr);
    const outOffset = this._outputPtr >> 2;
    const frame = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = heap[outOffset + i] / SAMPLE_SCALE;
    this._outQueue.push(frame);
    this._inQueueLen = 0;
  }

  process(inputs, outputs) {
    if (this._destroyed) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];

    if (this._disabled) {
      // Pass-through
      const inCh = input && input[0];
      if (inCh && inCh.length === outCh.length) outCh.set(inCh);
      else outCh.fill(0);
      return true;
    }

    const inCh = input && input[0];

    // If the upstream mic is silent (track ended / mic off), emit zero and
    // reset buffers so there's no residual from a previous frame.
    if (!inCh || inCh.length === 0) {
      outCh.fill(0);
      this._inQueueLen = 0;
      this._outQueue = [];
      this._outReadOffset = 0;
      return true;
    }

    const n = inCh.length;  // typically 128

    // Accumulate input → full 480-sample frames → process → push to output queue.
    for (let i = 0; i < n; i++) {
      this._inQueue[this._inQueueLen++] = inCh[i];
      if (this._inQueueLen === FRAME_SIZE) this._processFrame();
    }

    // Drain output queue into outCh.
    let written = 0;
    while (written < n && this._outQueue.length > 0) {
      const frame = this._outQueue[0];
      const available = FRAME_SIZE - this._outReadOffset;
      const needed = n - written;
      const take = Math.min(available, needed);
      for (let j = 0; j < take; j++) outCh[written + j] = frame[this._outReadOffset + j];
      written += take;
      this._outReadOffset += take;
      if (this._outReadOffset >= FRAME_SIZE) {
        this._outQueue.shift();
        this._outReadOffset = 0;
      }
    }
    // Zero any remaining samples in outCh (happens at the very start while
    // the first 480 samples accumulate — outputs silence for a few ms).
    if (written < n) outCh.fill(0, written);

    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
