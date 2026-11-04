/**
 * The audio thread of the page that hears a call: the microphone (input 0) and
 * what the computer plays (input 1), block by block on one clock, so a moment
 * of one can be held up against the same moment of the other. Handed to the
 * page in tenths of a second. No outputs: nothing heard here is played.
 */

const BLOCK = 1600;

class PerryMixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mic = new Float32Array(BLOCK);
    this.system = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const length = inputs[0]?.[0]?.length ?? inputs[1]?.[0]?.length ?? 128;
    for (let at = 0; at < length; at += 1) {
      this.mic[this.filled] = mono(inputs[0], at);
      this.system[this.filled] = mono(inputs[1], at);
      this.filled += 1;
      if (this.filled === BLOCK) {
        this.port.postMessage({ mic: this.mic, system: this.system }, [this.mic.buffer, this.system.buffer]);
        this.mic = new Float32Array(BLOCK);
        this.system = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

function mono(channels, at) {
  if (!channels?.length) return 0;
  let sum = 0;
  for (const channel of channels) sum += channel[at] ?? 0;
  return sum / channels.length;
}

registerProcessor("perry-mixer", PerryMixer);
