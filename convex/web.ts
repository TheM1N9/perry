"use node";

import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import TurndownService from "turndown";
import { Agent, fetch } from "undici";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { describeError, UNSAFE_DESTINATION } from "./lib/errors";
import { truncateHead } from "./lib/truncate";

/**
 * Reading public web pages.
 *
 * OpenMuse drives a real Chromium in a separate worker, with persistent
 * profiles so logins survive. This is the honest smaller version: an HTTP fetch
 * turned into Markdown. It reads articles, docs and changelogs perfectly well,
 * and it cannot read anything that needs JavaScript or a login.
 *
 * Saying so matters, because the failure mode of a headless fetch on a
 * JavaScript-rendered page is not an error, it is a confidently empty page. The
 * tool reports how much text it found so the agent can notice.
 *
 * Node, not Convex's default runtime, because the address checks need to see
 * DNS answers and choose the socket's address, which only undici and node:dns
 * allow.
 */

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Watches fingerprint the first this-many characters, as they always have. */
const MONITOR_TEXT_CHARS = 30_000;

/**
 * Browser-like, so servers send the page a person would see rather than a
 * bot-degraded one. Cloudflare challenges it from Node; see fetchPublic.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const HONEST_USER_AGENT = "Perry/0.1 (personal assistant; +https://github.com/TheM1N9/perry)";

// --- Which addresses are public --------------------------------------------

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/shared/network-address.ts
const reservedRanges = new BlockList();
reservedRanges.addSubnet("0.0.0.0", 8, "ipv4"); // "this network" / unspecified
reservedRanges.addSubnet("10.0.0.0", 8, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("100.64.0.0", 10, "ipv4"); // RFC6598 carrier-grade NAT
reservedRanges.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
reservedRanges.addSubnet("169.254.0.0", 16, "ipv4"); // link-local incl. cloud metadata
reservedRanges.addSubnet("172.16.0.0", 12, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
reservedRanges.addSubnet("192.0.2.0", 24, "ipv4"); // documentation
reservedRanges.addSubnet("192.88.99.0", 24, "ipv4"); // deprecated 6to4 relay anycast
reservedRanges.addSubnet("192.168.0.0", 16, "ipv4"); // RFC1918 private
reservedRanges.addSubnet("198.18.0.0", 15, "ipv4"); // RFC2544 benchmarking
reservedRanges.addSubnet("198.51.100.0", 24, "ipv4"); // documentation
reservedRanges.addSubnet("203.0.113.0", 24, "ipv4"); // documentation
reservedRanges.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
reservedRanges.addSubnet("240.0.0.0", 4, "ipv4"); // reserved and limited broadcast
reservedRanges.addAddress("::", "ipv6"); // unspecified
reservedRanges.addAddress("::1", "ipv6"); // loopback
reservedRanges.addSubnet("::", 96, "ipv6"); // IPv4-compatible addresses
reservedRanges.addSubnet("64:ff9b::", 96, "ipv6"); // well-known NAT64 prefix
reservedRanges.addSubnet("64:ff9b:1::", 48, "ipv6"); // local-use NAT64 prefix
reservedRanges.addSubnet("100::", 64, "ipv6"); // discard-only
reservedRanges.addSubnet("2001::", 23, "ipv6"); // special-purpose
reservedRanges.addSubnet("2001:db8::", 32, "ipv6"); // documentation
reservedRanges.addSubnet("2002::", 16, "ipv6"); // 6to4
reservedRanges.addSubnet("fc00::", 7, "ipv6"); // unique-local
reservedRanges.addSubnet("fe80::", 10, "ipv6"); // link-local
reservedRanges.addSubnet("ff00::", 8, "ipv6"); // multicast

function unsafeDestination(): Error {
  const error = new Error("That address is not public: local, private, link-local and reserved addresses cannot be read.");
  error.name = UNSAFE_DESTINATION;
  return error;
}

/** Brackets and zone ids off, and IPv4-mapped IPv6 unwrapped so the IPv4 ranges apply. */
function normaliseAddress(host: string): string {
  const bare = host.trim().replace(/^\[(.*)\]$/u, "$1");
  const zone = bare.indexOf("%");
  const address = zone === -1 ? bare : bare.slice(0, zone);
  if (address.toLowerCase().startsWith("::ffff:")) {
    const candidate = address.slice("::ffff:".length);
    if (isIP(candidate) === 4) return candidate;
  }
  return address;
}

function assertPublicAddress(host: string): void {
  const address = normaliseAddress(host);
  const family = isIP(address);
  if (family !== 0 && reservedRanges.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw unsafeDestination();
  }
}

/**
 * IP literals never reach the DNS lookup, so they are checked here; names are
 * checked by what they resolve to.
 */
function assertPublicHostname(hostname: string): void {
  const host = normaliseAddress(hostname).toLowerCase().replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw unsafeDestination();
  assertPublicAddress(host);
}

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/execution/web-fetch/request.ts
/**
 * Resolve, refuse the name if any answer is not public, and connect to exactly
 * the answers that were checked. Checking a name and then letting the socket
 * resolve it again is how DNS rebinding gets through.
 */
function publicLookup(): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }

      try {
        for (const { address } of addresses) assertPublicAddress(address);
      } catch (refused) {
        callback(refused as Error, "", 0);
        return;
      }

      const matching =
        options.family === undefined || options.family === 0
          ? addresses
          : addresses.filter(({ family }) => family === options.family);

      if (matching.length === 0) {
        const missing = new Error(`Could not resolve "${hostname}" in the requested IP family.`);
        Object.assign(missing, { code: "ENOTFOUND" });
        callback(missing, "", 0);
        return;
      }

      if (options.all === true) {
        callback(null, matching);
        return;
      }
      callback(null, matching[0].address, matching[0].family);
    });
  };
}

// --- Fetching --------------------------------------------------------------

/**
 * Plain http is allowed as well as https, unlike eve. Watches are set on
 * whatever URL the owner has, plenty of small sites still serve only http, and
 * existing watches were created when http was accepted. The SSRF guard does
 * not depend on the scheme:
 * every connection, on either, goes through the same checked lookup. What http
 * gives up is integrity in transit, and page text is already treated as
 * untrusted data.
 */
function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs can be read.");
  }
  return url;
}

type RawPage = { url: string; status: number; contentType: string; body: string; challenged: boolean };

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/execution/web-fetch/request.ts
/** One request, no redirects followed, the body read up to the size cap. */
async function requestOnce(url: URL, userAgent: string, signal: AbortSignal): Promise<RawPage & { location: string | null }> {
  assertPublicHostname(url.hostname);
  // A dispatcher per request, so no pooled socket outlives the check that opened it.
  const dispatcher = new Agent({ connect: { lookup: publicLookup() } });
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect: "manual",
      signal,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const location = response.headers.get("location");
    if (location !== null && REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      return { url: url.toString(), status: response.status, contentType: "", body: "", challenged: false, location };
    }

    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error("The page is over the 5 MB limit.");
    }

    // Counted as it arrives: content-length can be missing or wrong.
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("The page is over the 5 MB limit.");
        chunks.push(chunk);
      }
    }

    return {
      url: url.toString(),
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
      challenged: response.status === 403 && response.headers.get("cf-mitigated") === "challenge",
      location: null,
    };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

/**
 * Fetch a public URL, following redirects by hand so every hop's address is
 * checked, not only the first. Throws on a refused address, a timeout, a
 * network failure or an oversized page.
 */
async function fetchPublic(raw: string): Promise<RawPage> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  const follow = async (userAgent: string): Promise<RawPage> => {
    let url = parseUrl(raw);
    for (let hops = 0; ; hops++) {
      const page = await requestOnce(url, userAgent, signal);
      if (page.location === null) return page;
      if (hops >= MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects.`);
      url = parseUrl(new URL(page.location, url).toString());
    }
  };

  const page = await follow(BROWSER_USER_AGENT);
  // Cloudflare can challenge a browser user agent from Node, because the TLS
  // fingerprint gives it away. An honest one usually gets the page.
  if (page.challenged) {
    return await follow(HONEST_USER_AGENT);
  }
  return page;
}

const isHtml = (page: RawPage) => page.contentType.includes("html") || page.body.trimStart().startsWith("<");

// --- Turning a page into text ----------------------------------------------

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/execution/web-fetch/html.ts
/**
 * HTML to Markdown, so headings, links, lists and code survive for the model.
 * The title is returned separately, and noscript is dropped because its
 * "please enable JavaScript" would hide the near-empty-page tell.
 */
function toMarkdown(html: string): string {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    hr: "---",
  });
  service.remove(["script", "style", "meta", "link", "noscript", "title"]);
  return service
    .turndown(html)
    .replace(/^[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip a page to plain text. Crude and predictable, and kept exactly as it
 * was: watches fingerprint its output, and any change to it would make every
 * change watch fire once for no reason.
 */
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
    .replace(/[ \t ]+/g, " ")
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
  hint?: string;
};

export async function fetchPage(raw: string): Promise<FetchedPage> {
  let page: RawPage;
  try {
    page = await fetchPublic(raw);
  } catch (error) {
    const { message, hint } = describeError(error);
    return { error: message, ...(hint ? { hint } : {}) };
  }

  if (page.status < 200 || page.status >= 300) {
    return { url: page.url, error: `The site returned ${page.status}.` };
  }

  const html = isHtml(page);
  const title = html ? extractText(page.body).title : "";
  const markdown = html ? toMarkdown(page.body) : page.body.trim();
  const { output, truncated, outputLines, totalLines } = truncateHead(markdown);

  return {
    url: page.url,
    title,
    text: truncated
      ? `${output}\n\n[page truncated: showing the first ${outputLines} of ${totalLines} lines]`
      : output,
    chars: markdown.length,
    truncated,
    // The tell for a JavaScript-rendered page: HTTP 200, almost no text.
    note:
      markdown.length < 120
        ? "Almost no text came back. The page probably renders with JavaScript, which this cannot run."
        : undefined,
  };
}

/** Plain text for watches, the same text their fingerprints were taken over. */
async function fetchPageText(raw: string): Promise<{ text?: string; error?: string }> {
  try {
    const page = await fetchPublic(raw);
    if (page.status < 200 || page.status >= 300) return { error: `The site returned ${page.status}.` };
    const text = isHtml(page) ? extractText(page.body).text : page.body;
    return { text: text.slice(0, MONITOR_TEXT_CHARS) };
  } catch (error) {
    return { error: describeError(error).message };
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
      const page = await fetchPageText(monitor.url);

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
