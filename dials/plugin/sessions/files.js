// File mechanics with no Claude knowledge: when to reread a JSON file, and how to follow an
// append-only text file by byte offset. facts.js owns every path and format; this file owns
// every byte offset and stat comparison, so neither has to learn the other's rules.

import { open, readFile, stat } from "node:fs/promises";

const NEWLINE = 0x0a;
const FIRST_WINDOW = 64 * 1024;

/**
 * Identity of one version of a file. Equal stamps mean the bytes did not change, so a cached
 * parse is still right. ino catches atomic replace, size and mtime catch in-place writes.
 * @typedef {string} Stamp
 */

/**
 * @param {import("node:fs").Stats} stats
 * @returns {Stamp}
 */
export function stampOf(stats) {
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

/**
 * @param {string} path
 * @returns {Promise<import("node:fs").Stats | null>} null when the file is missing
 */
export async function statIfExists(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Parsed JSON files, reread only when a file's stamp changes.
 *
 * Invariant, the same for every source that uses it: a file that exists but fails to parse
 * (half-written, unknown shape) keeps its last good value, and a file that is gone is gone.
 * Use one instance per source, since `parse` decides the value type.
 *
 * @template T
 */
export class JsonFiles {
  #parse;
  /** @type {Map<string, { stamp: Stamp, value: T | null }>} */
  #entries = new Map();

  /** @param {(json: unknown) => T | null} parse  returns null for a shape it does not accept */
  constructor(parse) {
    this.#parse = parse;
  }

  /**
   * The parsed value of `path` as of `stats`. The caller passes stats because it already
   * stat'ed the file to list or order it, and a second stat could disagree with the first.
   * @param {string} path
   * @param {import("node:fs").Stats} stats
   * @returns {Promise<T | null>}
   */
  async get(path, stats) {
    const cached = this.#entries.get(path);
    const stamp = stampOf(stats);
    if (cached?.stamp === stamp) return cached.value;
    let json;
    try {
      json = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // Half-written or vanished between stat and read. The old stamp stays, so the next poll reads it again.
      return cached?.value ?? null;
    }
    // Valid JSON of an unknown shape is final for this stamp, so it is not reread every poll.
    const value = this.#parse(json) ?? cached?.value ?? null;
    this.#entries.set(path, { stamp, value });
    return value;
  }

  /**
   * Forget every path not in `paths`, so the cache never outgrows the folder it mirrors.
   * @param {Iterable<string>} paths
   */
  retain(paths) {
    const keep = new Set(paths);
    for (const path of this.#entries.keys()) if (!keep.has(path)) this.#entries.delete(path);
  }
}

/**
 * Where a follower of one append-only file stands. `end` is always at a line start.
 * @typedef {object} Cursor
 * @property {number} ino
 * @property {number} end
 */

async function openIfExists(path) {
  try {
    return await open(path, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRange(handle, from, to) {
  const buffer = Buffer.alloc(to - from);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Complete lines from `offset` up to the last newline. Bytes after the last newline belong to a
 * line still being written and are left for the next call. Cutting at "\n" is safe for UTF-8
 * because 0x0A never occurs inside a multi-byte sequence.
 *
 * @param {string} path
 * @param {number} offset  must be a line start (0 or a previous `end`)
 * @returns {Promise<{ lines: string[], cursor: Cursor, size: number } | null>} null when the file is missing
 */
export async function readLinesFrom(path, offset) {
  const handle = await openIfExists(path);
  if (!handle) return null;
  try {
    const { ino, size } = await handle.stat();
    const bytes = offset < size ? await readRange(handle, offset, size) : Buffer.alloc(0);
    const last = bytes.lastIndexOf(NEWLINE);
    if (last === -1) return { lines: [], cursor: { ino, end: offset }, size };
    return {
      lines: bytes.toString("utf8", 0, last).split("\n"),
      cursor: { ino, end: offset + last + 1 },
      size,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Start offset of the last complete line that `wanted` accepts, scanning backward from the end
 * in chunks that start at 64 KB and double. A transcript reaches 18 MB and one line 1.3 MB, so
 * the common case is one small read and the worst case reads the file once.
 *
 * @param {string} path
 * @param {(line: string) => boolean} wanted
 * @returns {Promise<{ offset: number, ino: number } | null>} offset 0 when no line matches; null when the file is missing
 */
export async function findLastLine(path, wanted) {
  const handle = await openIfExists(path);
  if (!handle) return null;
  try {
    const { ino, size } = await handle.stat();
    let start = size;
    let buffer = Buffer.alloc(0);
    /** Absolute offset of the "\n" that ends the next line to test; null until one is seen. */
    let nextEnd = null;
    for (let window = FIRST_WINDOW; ; window *= 2) {
      const from = Math.max(0, size - window);
      buffer = Buffer.concat([await readRange(handle, from, start), buffer]);
      start = from;
      if (nextEnd === null) {
        const last = buffer.lastIndexOf(NEWLINE);
        if (last !== -1) nextEnd = start + last;
      }
      while (nextEnd !== null) {
        const end = nextEnd - start;
        const before = end === 0 ? -1 : buffer.lastIndexOf(NEWLINE, end - 1);
        // The first piece of a window that does not start at 0 may be cut; a larger window covers it.
        if (before === -1 && start > 0) break;
        if (wanted(buffer.toString("utf8", before + 1, end))) return { offset: start + before + 1, ino };
        nextEnd = before === -1 ? null : start + before;
      }
      if (start === 0) return { offset: 0, ino };
    }
  } finally {
    await handle.close();
  }
}
