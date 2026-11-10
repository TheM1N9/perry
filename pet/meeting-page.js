/**
 * Hearing a call: the microphone (the owner) and what the computer plays (the
 * others on the call), cut where people pause into chunks for Whisper. This
 * runs in a hidden window of its own (listen.js), not his page, which is
 * replaced whenever it reloads. Nothing here is kept or played; closing the
 * window ends all of it.
 *
 * The browser's audio processing handles microphone echo and noise. Both
 * sources remain independent when people talk over each other.
 */

(() => {
  const SAMPLE_RATE = 16_000;
  const BLOCK_MS = 100;
  /** As components/pet/voice.tsx has it: below this (-46 dBFS), nothing was said. */
  const SPEECH_FLOOR = 0.002;
  /** How far above the room's own hum a block must be to count as someone speaking. */
  const OVER_HUM = 3;
  /** A chunk ends at a pause of this many blocks, or a shorter one once it is long enough, or at the longest Whisper reads well. */
  const LONG_PAUSE = 12;
  const SHORT_PAUSE = 5;
  const ENOUGH = 50;
  const LONGEST = 250;
  /** Kept from before someone starts, so their first sound is in the chunk. */
  const LEAD_IN = 2;
  /** Fewer spoken blocks than this is a cough or a door. */
  const FEWEST_SPOKEN = 4;
  /** How often the window hears how much sound there has been. */
  const REPORT_MS = 1_000;

  const bridge = window.perryMeeting;
  let context = null;
  const streams = [];
  let seq = 0;
  let heardAt = { mic: 0, system: 0 };
  let peak = { mic: 0, system: 0 };
  let reportTimer = 0;
  let clock = 0;

  const rms = (samples) => {
    let squares = 0;
    for (const value of samples) squares += value * value;
    return Math.sqrt(squares / samples.length);
  };

  /** One voice's chunks: the blocks since it started speaking, until it pauses. */
  function chunker(source) {
    let open = null;
    let lead = [];
    let quiet = 0;
    let hum = 0.0005;

    const cut = () => {
      const blocks = open.blocks.slice(0, open.blocks.length - Math.min(Math.max(0, quiet - 2), open.blocks.length));
      if (open.spoken >= FEWEST_SPOKEN && blocks.length) {
        const samples = new Float32Array(blocks.length * blocks[0].length);
        blocks.forEach((block, index) => samples.set(block, index * block.length));
        bridge.chunk({ seq: seq++, source, startMs: open.startMs, endMs: open.startMs + blocks.length * BLOCK_MS, samples });
      }
      open = null;
      quiet = 0;
      lead = [];
    };

    return {
      push(block, level, atMs) {
        // The hum follows a quiet room down at once, and up only slowly, so a long speech does not become it.
        hum = Math.min(hum * 1.005, Math.max(level, 1e-5));
        const spoken = level > Math.max(SPEECH_FLOOR, hum * OVER_HUM);
        if (!open) {
          if (!spoken) {
            lead.push(block);
            if (lead.length > LEAD_IN) lead.shift();
            return;
          }
          open = { blocks: lead, spoken: 0, startMs: atMs - lead.length * BLOCK_MS };
          lead = [];
        }
        open.blocks.push(block);
        if (spoken) {
          open.spoken += 1;
          quiet = 0;
        } else quiet += 1;
        const length = open.blocks.length;
        if (quiet >= LONG_PAUSE || (quiet >= SHORT_PAUSE && length >= ENOUGH) || length >= LONGEST) cut();
      },
      flush() { if (open) cut(); },
    };
  }

  const you = chunker("you");
  const them = chunker("them");

  function hear({ mic, system }) {
    const atMs = clock;
    clock += BLOCK_MS;
    const micLevel = rms(mic);
    const systemLevel = rms(system);
    you.push(mic, micLevel, atMs);
    them.push(system, systemLevel, atMs);
    if (micLevel > SPEECH_FLOOR) heardAt.mic = Date.now();
    if (systemLevel > SPEECH_FLOOR) heardAt.system = Date.now();
    peak.mic = Math.max(peak.mic, micLevel);
    peak.system = Math.max(peak.system, systemLevel);
  }

  const openMic = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    streams.push(stream);
    return stream;
  };

  /** What the computer plays. The picture Chromium insists on comes with it, and goes at once. */
  const openSystem = async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    streams.push(stream);
    return stream;
  };

  const says = (error) => `${error?.name ?? "Error"}: ${error?.message ?? error}`;

  window.perryListen = {
    /** Open both ears; the answer says which are open, and why not. Each that dies later is reported then. */
    async start() {
      context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
      await context.audioWorklet.addModule("meeting-worklet.js");
      const mixer = new AudioWorkletNode(context, "perry-mixer", { numberOfInputs: 2, numberOfOutputs: 0 });
      mixer.port.onmessage = (event) => hear(event.data);
      const status = { mic: "off", system: "off" };
      const connect = (stream, input, name) => {
        const [track] = stream.getAudioTracks();
        // A Mac that has not allowed system audio gives a track already ended, which never says anything.
        if (!track || track.readyState === "ended") {
          status[name] = "no audio";
          return;
        }
        context.createMediaStreamSource(stream).connect(mixer, 0, input);
        status[name] = "live";
        track.addEventListener("ended", () => bridge.status({ [name]: "ended" }));
      };
      try {
        connect(await openMic(), 0, "mic");
      } catch (error) { status.mic = says(error); }
      if (bridge.loopback && bridge.screenAccess && bridge.screenAccess !== "granted") {
        status.system = "System audio needs permission. Allow Electron in System Settings → Privacy & Security → Screen & System Audio Recording, then restart the pet. If it isn't listed, use Show Perry the screen once.";
      } else if (bridge.loopback) {
        try { connect(await openSystem(), 1, "system"); } catch (error) { status.system = says(error); }
      } else status.system = "unsupported";
      if (context.state === "suspended") await context.resume();
      const startedAt = Date.now();
      reportTimer = window.setInterval(() => {
        bridge.status({ heard: { mic: heardAt.mic, system: heardAt.system }, peak: { ...peak }, runningMs: Date.now() - startedAt });
        peak = { mic: 0, system: 0 };
      }, REPORT_MS);
      return status;
    },
    /** Stop hearing, and hand over what was still being said. */
    async stop() {
      window.clearInterval(reportTimer);
      for (const stream of streams) for (const track of stream.getTracks()) track.stop();
      await context?.close().catch(() => {});
      you.flush();
      them.flush();
      bridge.status({ closed: true });
    },
  };
})();
