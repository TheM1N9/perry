import { EventEmitter } from "node:events";

export type CartesiaConfig = {
  apiKey: string;
  model?: string; // e.g. "sonic-2" or "sonic"
  voice?: string;
  sampleRate?: number; // 24000
  channels?: number; // 1
};

export class CartesiaRealtime extends EventEmitter {
  private ws: any = null;
  private closed = false;

  constructor(private config: CartesiaConfig) {
    super();
  }

  async connect() {
    // Minimal no-op; real WS later if key present
    this.emit("connected");
  }

  sendPcm16(bytes: Uint8Array) {
    // drop for now
  }

  flush() {}

  end() {
    this.closed = true;
    this.emit("ended");
  }
}
