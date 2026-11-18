// This week's plan usage, as the Claude app last fetched it. The app's renderer refetches its
// organization's usage endpoint while its window is visible, and Chromium keeps each response in
// the app's HTTP disk cache. This file owns that cache's file naming and layout and the
// response's shape, and returns PlanUsage. It decides nothing about what a key shows; board.js does.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
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
  return {
    key: buffer.toString("utf8", HEADER_SIZE, keyEnd),
    body: buffer.subarray(keyEnd, eof),
    ...responseOf(buffer.subarray(eof + EOF_SIZE)),
  };
}

/** @param {Buffer} stream  stream 0, the response info */
function responseOf(stream) {
  const headers = rawHeaders(stream);
  const date = Date.parse(headers.get("date") ?? "");
  return {
    encoding: headers.get("content-encoding")?.toLowerCase() ?? "identity",
    date: Number.isFinite(date) ? date : null,
  };
}

// Chromium's blockfile cache, which the Windows build uses. Entries are 256-byte blocks in data_1
// and the files chained after it; each block file starts with an 8 KB header. An entry points at
// its streams with cache addresses into data_N block files or f_xxxxxx files.
const BLOCK_FILE_HEADER = 8192;
const BLOCK_SIZE_BY_TYPE = [0, 36, 256, 1024, 4096];
const ENTRY_SIZE = 256;
const ENTRY_KEY_OFFSET = 96;
const ENTRY_NORMAL = 0;

/** @param {string} folder  a cache folder; true when it holds a blockfile cache */
async function isBlockfile(folder) {
  return (await statIfExists(join(folder, "data_1"))) !== null;
}

/**
 * Every normal entry whose key is one of `keys`. A freed entry can keep its bytes in place, so a
 * key can match more than once; the caller keeps the newest response that decodes.
 * @param {string} folder
 * @param {readonly string[]} keys
 * @returns {Promise<CacheEntry[]>}
 */
async function blockfileEntries(folder, keys) {
  const found = [];
  const seen = new Set();
  let number = 1;
  while (number !== 0 && !seen.has(number)) {
    seen.add(number);
    const entries = await readFile(join(folder, `data_${number}`));
    for (const key of keys) {
      for (let at = entries.indexOf(key); at !== -1; at = entries.indexOf(key, at + 1)) {
        const entry = await blockfileEntryAt(folder, entries, at - ENTRY_KEY_OFFSET, key);
        if (entry) found.push(entry);
      }
    }
    number = entries.readInt16LE(10);
  }
  return found;
}

/**
 * @returns {Promise<CacheEntry | null>}  null where `start` is not a normal entry for `key`, or
 *   where its streams are gone, as a stale entry's f_ file can be
 */
async function blockfileEntryAt(folder, entries, start, key) {
  if (start < BLOCK_FILE_HEADER || (start - BLOCK_FILE_HEADER) % ENTRY_SIZE !== 0) return null;
  if (entries.readInt32LE(start + 32) !== Buffer.byteLength(key) || entries.readInt32LE(start + 20) !== ENTRY_NORMAL) return null;
  try {
    const info = await readStream(folder, entries.readUInt32LE(start + 56), entries.readInt32LE(start + 40));
    const body = await readStream(folder, entries.readUInt32LE(start + 60), entries.readInt32LE(start + 44));
    return info && body ? { key, body, ...responseOf(info) } : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** @returns {Promise<Buffer | null>} null for an unset address or one that cannot hold `size` bytes */
async function readStream(folder, address, size) {
  if (!(address & 0x80000000) || size <= 0) return null;
  const type = (address >>> 28) & 7;
  let path = join(folder, `f_${(address & 0x0fffffff).toString(16).padStart(6, "0")}`);
  let position = 0;
  if (type !== 0) {
    const blockSize = BLOCK_SIZE_BY_TYPE[type];
    if (!blockSize || size > blockSize * (((address >>> 24) & 3) + 1)) return null;
    path = join(folder, `data_${(address >>> 16) & 0xff}`);
    position = BLOCK_FILE_HEADER + (address & 0xffff) * blockSize;
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, position);
    return bytesRead === size ? buffer : null;
  } finally {
    await handle.close();
  }
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
  return usageOfEntry(entry, mtimeMs, zstdClis);
}

/**
 * @param {CacheEntry} entry
 * @param {number} mtimeMs  when the cache wrote it, for a response without a date header
 * @param {readonly string[]} zstdClis
 * @returns {Promise<PlanUsage>}
 */
async function usageOfEntry(entry, mtimeMs, zstdClis) {
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
  /** @type {Map<string, { stamp: string, usage: PlanUsage | null }>} the last good parse per cache file name; null where a blockfile cache has no entry */
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
    if (org !== null && (await isBlockfile(this.#folder))) return this.#readBlockfile(usageUrls(org));
    let newest = null;
    for (const url of org === null ? [] : usageUrls(org)) {
      const usage = await this.#readFile(cacheFileName(url), url);
      if (usage && (newest === null || usage.fetchedAt > newest.fetchedAt)) newest = usage;
    }
    return newest;
  }

  /**
   * The blockfile cache rewrites data_1 whenever any entry changes, so its stamp, with the org,
   * decides whether to look again. An entry caught mid-write fails to decode and is skipped; with
   * none decoding, the last good reading stays.
   * @param {readonly string[]} urls
   * @returns {Promise<PlanUsage | null>}
   */
  async #readBlockfile(urls) {
    const name = "data_1";
    try {
      const stats = await statIfExists(join(this.#folder, name));
      if (!stats) return null;
      const stamp = `${stampOf(stats)} ${urls[0]}`;
      const cached = this.#parsed.get(name);
      if (cached?.stamp === stamp) return cached.usage;
      let newest = null;
      let problem = null;
      for (const entry of await blockfileEntries(this.#folder, urls.map((url) => KEY_PREFIX + url))) {
        try {
          const usage = await usageOfEntry(entry, stats.mtimeMs, this.#zstdClis);
          if (newest === null || usage.fetchedAt > newest.fetchedAt) newest = usage;
        } catch (error) {
          problem ??= error;
        }
      }
      if (newest === null && problem) throw problem;
      this.#parsed.set(name, { stamp, usage: newest });
      if (this.#problems.delete(name)) this.#report("usage", `${name} recovered`);
      return newest;
    } catch (error) {
      const problem = `${name} ${error instanceof Unreadable ? error.message : (error.code ?? error.name)}`;
      if (this.#problems.get(name) !== problem) {
        this.#problems.set(name, problem);
        this.#report("usage", problem);
      }
      return this.#parsed.get(name)?.usage ?? null;
    }
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
