import type { AudioFrame, RealtimeVoiceConfig, VoiceEvents } from "./wa-bridge";

export interface RealtimeClient {
  connect(): Promise<void>;
  sendPcm16(bytes: Uint8Array): void;
  interrupt(): void;
  end(): void;
}

export async function createRealtimeClient(cfg: RealtimeVoiceConfig, events: VoiceEvents): Promise<RealtimeClient> {
  // Simple passthrough stub (no external calls unless provider configured)
  let closed = false;
  return {
    async connect() {},
    sendPcm16() {},
    interrupt() {},
    end() {
      closed = true;
      events.onEnd?.();
    },
  };
}
