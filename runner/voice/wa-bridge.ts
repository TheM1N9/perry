import { setTimeout as sleep } from "node:timers/promises";

export type WaCallContext = {
  callId: string; // Baileys call id or internal
  conversationId: string;
  channelId?: string;
  userId?: string;
  waFrom?: string;
  waTo?: string;
};

export type AudioFrame = {
  // Int16 LE PCM or Opus bytes; bridge works with chunks
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  durationMs?: number;
};

export type RealtimeVoiceConfig = {
  provider: "cartesia" | "openai" | "orpheus" | "hume";
  apiKey?: string;
  model?: string;
  voice?: string;
  sampleRate: number; // e.g. 16000 or 24000
  channels: number; // 1
  language?: string;
  enableTools?: boolean;
};

export type VoiceEvents = {
  onUserSpeechStart?: () => void;
  onUserSpeechEnd?: () => void;
  onAgentAudio?: (frame: AudioFrame) => void;
  onAgentText?: (text: string) => void;
  onUserText?: (text: string) => void;
  onToolCall?: (tool: { name: string; args: unknown }) => void;
  onError?: (err: unknown) => void;
  onEnd?: () => void;
};

export class WaVoiceBridge {
  private closed = false;
  private agentSpeaking = false;
  private lastUserFrameAt = 0;

  constructor(
    private ctx: WaCallContext,
    private voice: RealtimeVoiceConfig,
    private events: VoiceEvents = {},
  ) {}

  async start() {
    // Minimal stub: ready to bridge. Real impl added next (WebSocket + VAD).
    this.lastUserFrameAt = Date.now();
  }

  pushUserAudio(frame: AudioFrame) {
    if (this.closed) return;
    this.lastUserFrameAt = Date.now();
    // Barge-in: flush/notify agent to stop speaking on user speech
    if (this.agentSpeaking) {
      this.agentSpeaking = false;
      this.events.onUserSpeechStart?.();
    }
    // TODO: send to realtime STT stream
  }

  pushAgentAudio(frame: AudioFrame) {
    this.agentSpeaking = true;
    this.events.onAgentAudio?.(frame);
  }

  end() {
    this.closed = true;
    this.events.onEnd?.();
  }

  async waitUntilEnded(ms = 5000) {
    const start = Date.now();
    while (!this.closed && Date.now() - start < ms) {
      await sleep(50);
    }
  }
}
