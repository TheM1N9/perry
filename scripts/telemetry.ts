import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../runner/home";

type Milestone = "Installation completed" | "Setup configured";
type Receipt = { uuid: string; timestamp: string; sent?: boolean };
type Ledger = { installationId: string; events: Partial<Record<Milestone, Receipt>> };

/** Best effort, once per installation/milestone. No credentials or machine names. */
export async function trackInstallation(event: Milestone): Promise<void> {
  if (process.env.PERRY_TELEMETRY_DISABLED === "1" || process.env.NEXT_PUBLIC_POSTHOG_ENABLED === "false") return;
  try {
    const file = join(HOME, "analytics.json");
    mkdirSync(HOME, { recursive: true });
    const ledger: Ledger = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { installationId: randomUUID(), events: {} };
    if (ledger.events[event]?.sent) return;
    const receipt = ledger.events[event] ??= { uuid: randomUUID(), timestamp: new Date().toISOString() };
    const persist = () => {
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(ledger, null, 2), { mode: 0o600 });
      renameSync(temporary, file);
    };
    // Persist the event UUID first: an interrupted retry is deduplicated by PostHog.
    persist();
    const response = await fetch("https://us.i.posthog.com/i/v0/e/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        api_key: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "phc_qeCkb5s5b6x4T5adoyZWdCKsmwK27dKq3RginMwWAwqn",
        uuid: receipt.uuid,
        timestamp: receipt.timestamp,
        event,
        properties: {
          distinct_id: ledger.installationId,
          $process_person_profile: false,
          app: "installer",
          os: process.platform,
          arch: process.arch,
          node_version: process.versions.node,
        },
      }),
    });
    if (response.ok) {
      receipt.sent = true;
      persist();
    }
  } catch {
    // Offline analytics must never fail or delay installation beyond the timeout.
  }
}

if (import.meta.main) {
  const event = process.argv[2];
  if (event === "Installation completed" || event === "Setup configured") await trackInstallation(event);
}
