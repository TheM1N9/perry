import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/**
 * Reading public web pages.
 *
 * OpenMuse drives a real Chromium in a separate worker, with persistent
 * profiles so logins survive. This is the honest smaller version: an HTTP fetch
 * and a text extraction. It reads articles, docs and changelogs perfectly well,
 * and it cannot read anything that needs JavaScript or a login.
 *
 * Saying so matters, because the failure mode of a headless fetch on a
 * JavaScript-rendered page is not an error, it is a confidently empty page. The
 * tool reports how much text it found so the agent can notice.
 */

const MAX_PAGE_CHARS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
];

/**
 * Refuse anything that is not a public http(s) URL.
 *
 * Without this, "summarise this page for me" is a server-side request forgery
 * primitive pointed at the deployment's own network.
 */
function checkUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "That is not a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http and https URLs can be read." };
  }

  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.includes(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { error: "That address is not public." };
  }

  return { url };
}

/** Strip a page to readable text. Crude, predictable, no dependencies. */
export function extractText(html: string): { title: string; text: string } {
  const title =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  return { title: decodeEntities(title), text };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export type FetchedPage = {
  url?: string;
  title?: string;
  text?: string;
  chars?: number;
  truncated?: boolean;
  note?: string;
  error?: string;
};

export async function fetchPage(raw: string): Promise<FetchedPage> {
  const checked = checkUrl(raw);
  if ("error" in checked) return { error: checked.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(checked.url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Assistant/0.1 (personal assistant; +https://github.com)",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });

    if (!response.ok) {
      return { url: response.url, error: `The site returned ${response.status}.` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    const { title, text } =
      contentType.includes("html") || body.trimStart().startsWith("<")
        ? extractText(body)
        : { title: "", text: body };

    const truncated = text.length > MAX_PAGE_CHARS;

    return {
      url: response.url,
      title,
      text: text.slice(0, MAX_PAGE_CHARS),
      chars: text.length,
      truncated,
      // The tell for a JavaScript-rendered page: HTTP 200, almost no text.
      note:
        text.length < 120
          ? "Almost no text came back. The page probably renders with JavaScript, which this cannot run."
          : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: message.includes("abort")
        ? "The page took too long to respond."
        : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const read = internalAction({
  args: { url: v.string() },
  handler: async (_ctx, args): Promise<FetchedPage> => {
    return await fetchPage(args.url);
  },
});

/** Stable enough to compare across checks, ignoring whitespace churn. */
function fingerprint(text: string): string {
  const normalised = text.replace(/\s+/g, " ").trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalised.length; i++) {
    hash = (hash * 31 + normalised.charCodeAt(i)) | 0;
  }
  return `${normalised.length}:${hash}`;
}

function firstPrice(text: string): number | null {
  const match = text.match(/(?:US)?\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * Check every monitor that is due. Called by the cron.
 *
 * The rule that makes this bearable to live with: the first check of a
 * `change` monitor only records a baseline. Otherwise every new watch fires
 * immediately and the owner learns to ignore Assistant.
 */
export const checkMonitors = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const due = await ctx.runQuery(internal.work.dueMonitors, {});

    for (const monitor of due) {
      const page = await fetchPage(monitor.url);

      if (page.error || !page.text) {
        await ctx.runMutation(internal.work.recordCheck, {
          id: monitor._id,
          observation: `Could not read the page: ${page.error ?? "no text"}`,
          fired: false,
          failed: true,
        });
        continue;
      }

      const print = fingerprint(page.text);
      let fired = false;
      let observation = "No change.";

      if (monitor.condition === "change") {
        if (!monitor.lastFingerprint) {
          observation = "Baseline recorded.";
        } else if (monitor.lastFingerprint !== print) {
          fired = true;
          observation = "The page changed.";
        }
      } else if (monitor.condition === "contains") {
        const needle = (monitor.value ?? "").toLowerCase();
        const present = needle.length > 0 && page.text.toLowerCase().includes(needle);
        if (present && !monitor.firedAt) {
          fired = true;
          observation = `Found "${monitor.value}" on the page.`;
        } else {
          observation = present ? `Still there.` : `Not on the page.`;
        }
      } else if (monitor.condition === "price_below") {
        const target = Number(monitor.value);
        const found = firstPrice(page.text);
        if (found === null) {
          observation = "No price found on the page.";
        } else if (Number.isFinite(target) && found < target) {
          fired = true;
          observation = `Price is $${found}, below $${target}.`;
        } else {
          observation = `Price is $${found}.`;
        }
      }

      await ctx.runMutation(internal.work.recordCheck, {
        id: monitor._id,
        fingerprint: print,
        observation,
        fired,
        failed: false,
      });

      if (fired) {
        await ctx.runAction(internal.notify.toOwner, {
          text: `${monitor.title}\n${observation}\n${monitor.url}`,
        });
      }
    }

    return null;
  },
});
