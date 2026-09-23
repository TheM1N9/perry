#!/usr/bin/env bun
/**
 * Register, inspect, or remove Perry's Telegram webhook.
 *
 *   pnpm run webhook:set
 *   pnpm run webhook:info
 *   pnpm run webhook:delete
 *
 * Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and CONVEX_SITE_URL from
 * .env.local. These are the local copies; the Convex deployment needs its own
 * via `pnpm exec convex env set`.
 */

// Bun loads .env and .env.local into process.env before this runs.
export {};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return value;
}

async function telegram(method: string, body?: object): Promise<any> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json() as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) {
    console.error(`Telegram ${method} failed: ${json.description}`);
    process.exit(1);
  }
  return json.result;
}

const command = process.argv[2] ?? "info";

if (command === "set") {
  const site = required("CONVEX_SITE_URL").replace(/\/$/, "");
  const secret = required("TELEGRAM_WEBHOOK_SECRET");

  if (!site.startsWith("https://")) {
    console.error("CONVEX_SITE_URL must be https. Telegram refuses plain http.");
    process.exit(1);
  }
  if (site.includes(".convex.cloud")) {
    console.error(
      "That is the .convex.cloud URL. Webhooks go to the .convex.site domain.",
    );
    process.exit(1);
  }

  const url = `${site}/telegram`;
  await telegram("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: true,
  });

  const me = await telegram("getMe");
  console.log(`Webhook set to ${url}`);
  console.log(`Bot is @${me.username}. Message it to claim Perry.`);
} else if (command === "delete") {
  await telegram("deleteWebhook", { drop_pending_updates: true });
  console.log("Webhook removed.");
} else {
  const info = await telegram("getWebhookInfo");
  console.log(JSON.stringify(info, null, 2));
  if (info.last_error_message) {
    console.log(`\nLast delivery error: ${info.last_error_message}`);
  }
}
