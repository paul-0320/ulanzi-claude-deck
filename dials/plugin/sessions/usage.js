// This week's plan usage, as the Claude app last fetched it. The app's renderer refetches its
// organization's usage endpoint while its window is visible, and Chromium keeps each response in
// the app's HTTP disk cache. This file owns that cache's file naming and layout and the
// response's shape, and returns PlanUsage. It decides nothing about what a key shows; board.js does.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import zlib from "node:zlib";
import { stampOf, statIfExists } from "./files.js";

/** The windows a usage key can show, as the preset's ActionParam {"window": ...} names them. */
export const USAGE_WINDOWS = Object.freeze(/** @type {const} */ (["all", "fable"]));

/** @typedef {typeof USAGE_WINDOWS[number]} UsageWindow */

/**
 * @typedef {object} Limit
 * @property {number} percent  0..100, floored, as the app shows it
 * @property {number | null} resetsAt  epoch ms; null when the response has no usable time
 */

/**
 * One usage response.
 * @typedef {object} PlanUsage
 * @property {number} fetchedAt  epoch ms the server answered, else when the cache wrote the file
 * @property {Readonly<Record<UsageWindow, Limit | null>>} limits  null when the response has no limit for that window
 */

/**
 * @param {unknown} value  the preset's window param, unvalidated
 * @returns {UsageWindow | null}
 */
export function parseWindow(value) {
  return USAGE_WINDOWS.find((window) => window === value) ?? null;
}

/**
 * Where each window's number sits in the response: the limits[] entry it matches, and for "all"
 * the older seven_day field, read when limits[] has no such entry.
 * @type {Readonly<Record<UsageWindow, { matches: (entry: any) => boolean, fallback: (json: any) => unknown }>>}
 */
const SOURCES = Object.freeze({
  all: {
    matches: (entry) => entry.kind === "weekly_all",
    fallback: (json) => isRecord(json.seven_day) && { percent: json.seven_day.utilization, resets_at: json.seven_day.resets_at },
  },
  fable: {
    matches: (entry) => entry.kind === "weekly_scoped" && entry.scope?.model?.display_name === "Fable",
    fallback: () => null,
  },
});

/**
 * @param {unknown} json  a decoded usage response
 * @param {number} fetchedAt
 * @returns {PlanUsage | null}  null for a shape with neither a limits array nor seven_day
 */
export function planUsageOf(json, fetchedAt) {
  if (!isRecord(json) || (!Array.isArray(json.limits) && !isRecord(json.seven_day))) return null;
  const entries = Array.isArray(json.limits) ? json.limits.filter(isRecord) : [];
  const limits = Object.fromEntries(
    USAGE_WINDOWS.map((window) => {
      const { matches, fallback } = SOURCES[window];
      return [window, limitOf(entries.find(matches)) ?? limitOf(fallback(json))];
    }),
  );
  return Object.freeze({ fetchedAt, limits: Object.freeze(limits) });
}

/** @returns {Limit | null} */
function limitOf(raw) {
  if (!isRecord(raw) || !Number.isFinite(raw.percent)) return null;
  const resetsAt = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
  return Object.freeze({
    percent: Math.min(100, Math.max(0, Math.floor(raw.percent))),
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Chromium's simple cache, version 5: a 24-byte header, the key, stream 1 (the body), an EOF
// record, stream 0 (the response info with its raw headers), another EOF record.
const KEY_PREFIX = "1/0/";
const INITIAL_MAGIC = 0xfcfb6d1ba7725c30n;
const FINAL_MAGIC = Buffer.from("d8410d97456ffaf4", "hex");
const HEADER_SIZE = 24;
const EOF_SIZE = 24;

/**
 * The cache file that holds `url`'s response: the first 8 bytes of the key's SHA-1 read as a
 * little-endian u64, in hex.
 * @param {string} url
 */
export function cacheFileName(url) {
  const hash = createHash("sha1").update(KEY_PREFIX + url).digest();
  return `${hash.subarray(0, 8).reverse().toString("hex")}_0`;
}

/**
 * The URLs the app fetches the active organization's usage from. The oauth usage URL is left
 * out: it is not tied to an organization and refreshes only when a session asks for usage.
 * @param {string} org
 */
export function usageUrls(org) {
  const base = `https://claude.ai/api/organizations/${org}/usage`;
  return [base, `${base}?skip_spend=1`, `${base}?cedar_ember=1&skip_spend=1`, `${base}?at_wall=1&skip_spend=1`];
}

/**
 * @typedef {object} CacheEntry
 * @property {string} key       "1/0/" + url
 * @property {Buffer} body      as the server sent it, still content-encoded
 * @property {string} encoding  the content-encoding header, lowercased; "identity" without one
 * @property {number | null} date  epoch ms of the date header
 */

/**
 * @param {Buffer} buffer  a whole cache file
 * @returns {CacheEntry | null}  null for a file that is not a cache entry or is not finished
 */
export function cacheEntryOf(buffer) {
  if (buffer.length < HEADER_SIZE || buffer.readBigUInt64LE(0) !== INITIAL_MAGIC) return null;
  const keyEnd = HEADER_SIZE + buffer.readUInt32LE(12);
  if (keyEnd > buffer.length) return null;
  // The body's own EOF record leaves its stream_size at 0, so the record is found by its magic.
  const eof = buffer.indexOf(FINAL_MAGIC, keyEnd);
  if (eof === -1) return null;
  const headers = rawHeaders(buffer.subarray(eof + EOF_SIZE));
  const date = Date.parse(headers.get("date") ?? "");
  return {
    key: buffer.toString("utf8", HEADER_SIZE, keyEnd),
    body: buffer.subarray(keyEnd, eof),
    encoding: headers.get("content-encoding")?.toLowerCase() ?? "identity",
    date: Number.isFinite(date) ? date : null,
  };
}

/**
 * The response's headers by lowercased name. Stream 0 holds them as "HTTP/1.1 200\0name:value\0...\0\0".
 * @param {Buffer} stream
 * @returns {Map<string, string>}
 */
function rawHeaders(stream) {
  const start = stream.indexOf("HTTP/");
  const headers = new Map();
  if (start === -1) return headers;
  for (const line of stream.toString("latin1", start).split("\0").slice(1)) {
    if (line === "") break;
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

const ZSTD_TIMEOUT_MS = 2000;

/** A problem whose message is fixed text, safe for the log. Every other error logs its code or name only. */
class Unreadable extends Error {}

/** @type {Readonly<Record<string, (body: Buffer, zstdClis: readonly string[]) => Buffer | Promise<Buffer>>>} */
const DECODERS = Object.freeze({
  zstd: decodeZstd,
  br: (body) => zlib.brotliDecompressSync(body),
  gzip: (body) => zlib.gunzipSync(body),
  identity: (body) => body,
});

/**
 * Studio's Node 20 has no zstd in zlib, so the zstd CLI decodes there. It runs async because
 * the same event loop drives the knobs.
 * @param {Buffer} body
 * @param {readonly string[]} zstdClis
 */
async function decodeZstd(body, zstdClis) {
  if (zlib.zstdDecompressSync) return zlib.zstdDecompressSync(body);
  let cli = null;
  for (const path of zstdClis) if (!cli && (await statIfExists(path))) cli = path;
  if (!cli) throw new Unreadable("no zstd decoder");
  return new Promise((resolve, reject) => {
    const child = execFile(cli, ["-dcq"], { encoding: "buffer", timeout: ZSTD_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(new Unreadable(`zstd ${error.signal ?? error.code}`)) : resolve(stdout),
    );
    // zstd may exit before it reads all of stdin; its exit status already says so.
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
}

/**
 * @param {Buffer} bytes  a whole cache file
 * @param {string} url    the URL the file must hold
 * @param {number} mtimeMs
 * @param {readonly string[]} zstdClis
 * @returns {Promise<PlanUsage>}
 */
async function usageIn(bytes, url, mtimeMs, zstdClis) {
  const entry = cacheEntryOf(bytes);
  if (!entry) throw new Unreadable("not a finished cache entry");
  if (entry.key !== KEY_PREFIX + url) throw new Unreadable("holds another URL");
  const decode = DECODERS[entry.encoding];
  if (!decode) throw new Unreadable("unknown content-encoding");
  const usage = planUsageOf(JSON.parse((await decode(entry.body, zstdClis)).toString("utf8")), entry.date ?? mtimeMs);
  if (!usage) throw new Unreadable("unknown usage shape");
  return usage;
}

export class UsageReader {
  #folder;
  #zstdClis;
  #report;
  /** @type {Map<string, { stamp: string, usage: PlanUsage }>} the last good parse per cache file name */
  #parsed = new Map();
  /** @type {Map<string, string>} the last problem reported per cache file name, so a broken file logs once, not once a second */
  #problems = new Map();

  /**
   * @param {object} options
   * @param {Pick<import("../platform.js").Platform, "appData" | "zstdClis">} options.platform  where the app keeps its cache, and the zstd commands to try
   * @param {(source: string, problem: string) => void} [options.report]  called when a file's problem changes
   */
  constructor({ platform, report = () => {} }) {
    this.#folder = join(platform.appData, "Cache", "Cache_Data");
    this.#zstdClis = platform.zstdClis;
    this.#report = report;
  }

  /**
   * The newest reading among the organization's usage URLs. Never rejects. A file that fails to
   * read or parse keeps its last good reading; a file that is gone drops out.
   * @param {string | null} org
   * @returns {Promise<PlanUsage | null>}  null with no org or no readable file
   */
  async read(org) {
    let newest = null;
    for (const url of org === null ? [] : usageUrls(org)) {
      const usage = await this.#readFile(cacheFileName(url), url);
      if (usage && (newest === null || usage.fetchedAt > newest.fetchedAt)) newest = usage;
    }
    return newest;
  }

  /**
   * @param {string} name
   * @param {string} url
   * @returns {Promise<PlanUsage | null>}
   */
  async #readFile(name, url) {
    const path = join(this.#folder, name);
    const cached = this.#parsed.get(name);
    try {
      const stats = await statIfExists(path);
      if (!stats) {
        this.#parsed.delete(name);
        this.#problems.delete(name);
        return null;
      }
      const stamp = stampOf(stats);
      if (cached?.stamp === stamp) return cached.usage;
      const usage = await usageIn(await readFile(path), url, stats.mtimeMs, this.#zstdClis);
      this.#parsed.set(name, { stamp, usage });
      if (this.#problems.delete(name)) this.#report("usage", `${name} recovered`);
      return usage;
    } catch (error) {
      // The failed stamp is not kept, so the next poll tries the file again.
      const problem = `${name} ${error instanceof Unreadable ? error.message : (error.code ?? error.name)}`;
      if (this.#problems.get(name) !== problem) {
        this.#problems.set(name, problem);
        this.#report("usage", problem);
      }
      return cached?.usage ?? null;
    }
  }
}
