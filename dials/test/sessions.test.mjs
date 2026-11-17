// Session and usage keys, tested in the cheapest tier that can see each behavior: board, face,
// and the usage cache's parsing are pure; files and the readers run against temp folders; the
// plugin runs app.js as a child process with HOME set to a fake home and CLAUDE_DECK_OPEN set to
// a recorder, against a fake Studio server that reads the images the plugin sends. Nothing reads
// the developer's real home folder, and nothing opens a claude:// link.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, open, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { PLATFORMS } from "../plugin/platform.js";
import { EMPTY_BOARD, SLOT_COUNT, STATUSES, boardOf, parseSlot, usageTileOf } from "../plugin/sessions/board.js";
import { renderFrames, renderUsage } from "../plugin/sessions/face.js";
import { FactReader } from "../plugin/sessions/facts.js";
import { JsonFiles, findLastLine, readLinesFrom } from "../plugin/sessions/files.js";
import { USAGE_WINDOWS, UsageReader, cacheEntryOf, cacheFileName, parseWindow, planUsageOf } from "../plugin/sessions/usage.js";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const SESSION_KEY = "com.ulanzi.ulanzistudio.claudeeffort.sessionkey";
const USAGE_KEY = "com.ulanzi.ulanzistudio.claudeeffort.usagekey";
const EFFORT = "com.ulanzi.ulanzistudio.claudeeffort.dial";
const SCROLL = "com.ulanzi.ulanzistudio.claudeeffort.scroll";
const POLL_MS = 1000;
const BLINK_MS = 500;
const RESTART_MS = 1000;

/** A whole second an hour ago, so every fake activity time is older than any file mtime the tests write. */
const T0 = Math.floor(Date.now() / 1000) * 1000 - 3_600_000;
const at = (seconds) => T0 + seconds * 1000;

const localId = (n) => `local_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cliId = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;

const LABELS = { permission: "권한", question: "질문", working: "작업 중", review: "확인", idle: "쉼" };
/** The statuses that wait on a person flash; the rest hold still. */
const FRAME_COUNTS = { permission: 2, question: 2, working: 1, review: 1, idle: 1 };

// --- fixtures ---------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
function logStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Usage that adds up to `used` across the three input fields the context counts. */
function reply(used, { model = "claude-opus-5-5", sidechain = false } = {}) {
  return {
    type: "assistant",
    isSidechain: sidechain,
    message: {
      model,
      usage: { input_tokens: 2, cache_read_input_tokens: used - 102, cache_creation_input_tokens: 100, output_tokens: 40 },
    },
  };
}
const compact = (postTokens) => ({ type: "system", subtype: "compact_boundary", compactMetadata: { postTokens } });
const metadata = () => ({ type: "agent-name", agentName: "worker" });
const userLine = () => ({ type: "user", message: { role: "user", content: "usage please" } });

/** A value only the fake preference file holds, so a test can see that none of the file reaches the log. */
const PREFERENCE_SECRET = "mcp-secret-0f1e2d";

/**
 * The app's preference file: per account, a pinned section and, unless `null`, a session list
 * section with that sort, beside an unrelated setting.
 * @param {Record<string, { sortBy: string, ascending: boolean } | null>} byScope
 */
function sidebarPrefs(byScope) {
  const pinned = { id: "pinned", kind: "pinned", order: 0, groupBy: "none", sortBy: "created", ascending: true, collapsed: false, shown: true };
  const list = (sort) => ({ id: "sessions", kind: "sessions", order: 1, groupBy: "date", ...sort, collapsed: false, shown: true });
  const views = Object.entries(byScope).map(([scope, sort]) => [scope, { sections: sort ? [pinned, list(sort)] : [pinned] }]);
  return {
    mcpServers: { deck: { command: "/usr/bin/true", env: { TOKEN: PREFERENCE_SECRET } } },
    preferences: { epitaxyPrefs: { "dframe-code-sections": Object.fromEntries(views) } },
  };
}

const DAY_MS = 86_400_000;
const usageUrl = (org, query = "") => `https://claude.ai/api/organizations/${org}/usage${query}`;
const RESETS_AT = "2026-11-13T10:00:00.437919+00:00";
const RESETS_AT_MS = Date.UTC(2026, 10, 13, 10, 0, 0, 437);

/** A usage response as the app fetches it, cut to the fields the deck reads and a few beside them. */
function usageResponse({ all = 46, fable = 33, resetsAt = RESETS_AT } = {}) {
  return {
    five_hour: null,
    seven_day: { utilization: all, resets_at: resetsAt },
    limits: [
      { kind: "weekly_all", group: "weekly", percent: all, severity: "normal", resets_at: resetsAt, scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: fable, severity: "normal", resets_at: resetsAt, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
  };
}

const ZSTD_CLI = ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"].find((path) => existsSync(path));
/** Content encoders for cache fixtures. zstd is null where neither zlib nor a zstd CLI has it. */
const ENCODE = {
  identity: (bytes) => bytes,
  gzip: (bytes) => zlib.gzipSync(bytes),
  br: (bytes) => zlib.brotliCompressSync(bytes),
  zstd: zlib.zstdCompressSync ? (bytes) => zlib.zstdCompressSync(bytes) : ZSTD_CLI ? (bytes) => execFileSync(ZSTD_CLI, ["-cq"], { input: bytes }) : null,
};
const NO_ZSTD = ENCODE.zstd ? false : "neither zlib nor a zstd CLI can make a zstd fixture here";
/** The plugin tests use zstd, as the app does, when this machine can make it. */
const PLUGIN_ENCODING = ENCODE.zstd ? "zstd" : "gzip";

const CACHE_MAGIC = 0xfcfb6d1ba7725c30n;
function eofRecord(streamSize) {
  const record = Buffer.alloc(24);
  record.writeBigUInt64LE(0xf4fa6f45970d41d8n, 0);
  record.writeUInt32LE(1, 8);
  record.writeUInt32LE(streamSize, 16);
  return record;
}

/**
 * One file of Chromium's simple cache, laid out as the app's cache writes it: header, key, body,
 * an EOF record, the response info holding the raw headers, another EOF record. `finished: false`
 * stops after the body, as a file still being written does.
 */
function cacheFile({ url, json = usageResponse(), encoding = "gzip", date = null, magic = CACHE_MAGIC, finished = true }) {
  const key = Buffer.from(`1/0/${url}`);
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(magic, 0);
  header.writeUInt32LE(5, 8);
  header.writeUInt32LE(key.length, 12);
  const body = ENCODE[encoding](Buffer.from(typeof json === "string" ? json : JSON.stringify(json)));
  if (!finished) return Buffer.concat([header, key, body]);
  const lines = [
    "HTTP/1.1 200",
    ...(date === null ? [] : [`date:${new Date(date).toUTCString()}`]),
    "content-type:application/json",
    ...(encoding === "identity" ? [] : [`content-encoding:${encoding}`]),
  ];
  const raw = Buffer.from(`${lines.join("\0")}\0\0`, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(raw.length);
  const info = Buffer.concat([Buffer.from([0x4c, 0x02, 0, 0, 0x8c, 0x8d, 0xe0, 0x75, 0x9e, 0xbe, 0x2f, 0]), length, raw]);
  return Buffer.concat([header, key, body, eofRecord(0), info, eofRecord(info.length)]);
}

/** Where the app keeps its data and its logs under the home folder, spelled out apart from platform.js so a wrong row there fails. */
const APP_FOLDERS = {
  darwin: { appData: ["Library", "Application Support", "Claude"], logs: ["Library", "Logs", "Claude"] },
  win32: { appData: ["AppData", "Roaming", "Claude"], logs: ["AppData", "Roaming", "Claude", "logs"] },
};

/**
 * A fake home folder with Claude's six sources, laid out as the app on `os` lays them out, removed after the test.
 * @param {import("node:test").TestContext} t
 * @param {keyof typeof APP_FOLDERS} [os]
 */
async function fakeHome(t, os = "darwin") {
  const home = await mkdtemp(join(tmpdir(), "claude-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const appData = join(home, ...APP_FOLDERS[os].appData);
  const desktop = join(appData, "claude-code-sessions");
  const preferences = join(appData, "claude_desktop_config.json");
  const registry = join(home, ".claude", "sessions");
  const projects = join(home, ".claude", "projects");
  const logs = join(home, ...APP_FOLDERS[os].logs);
  const cacheData = join(appData, "Cache", "Cache_Data");
  const sessionFile = (id, account = "account/org") => join(desktop, account, `${id}.json`);
  const setMtime = (path, ms) => utimes(path, ms / 1000, ms / 1000);
  async function write(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const lines = (objects) => objects.map((object) => JSON.stringify(object) + "\n").join("");

  return {
    home,
    async session({ id, ...fields }, { account, mtime } = {}) {
      const path = sessionFile(id, account);
      await write(path, JSON.stringify({ sessionId: id, isArchived: false, cwd: "/work/deck", model: "claude-opus-5-5", ...fields }));
      if (mtime !== undefined) await setMtime(path, mtime);
    },
    touchSession: (id, mtime, account) => setMtime(sessionFile(id, account), mtime),
    touchAccount: (account, mtime) => setMtime(join(desktop, account), mtime),
    corruptSession: (id) => writeFile(sessionFile(id), `{"sessionId": "${id}", "title": "half`),
    /** Writes the preference file the way the app does: a temp file renamed over it. */
    async preferences(content) {
      await write(`${preferences}.tmp`, typeof content === "string" ? content : JSON.stringify(content));
      await rename(`${preferences}.tmp`, preferences);
    },
    async loopPreferences() {
      await mkdir(dirname(preferences), { recursive: true });
      await rm(preferences, { force: true });
      await symlink(preferences, preferences);
    },
    registry: ({ pid, ...fields }) => write(join(registry, `${pid}.json`), JSON.stringify({ pid, ...fields })),
    registryKeyFile: (pid, contents) => write(join(registry, `${pid}.0f1e2d3c4b5a.key`), contents),
    emptyRegistry: async () => {
      await rm(registry, { recursive: true, force: true });
      await mkdir(registry, { recursive: true });
    },
    removeRegistry: () => rm(registry, { recursive: true, force: true }),
    async transcript(cwd, id, objects, { folder = cwd.replace(/[^A-Za-z0-9]/g, "-") } = {}) {
      const path = join(projects, folder, `${id}.jsonl`);
      await write(path, lines(objects));
      return path;
    },
    appendTranscript: (path, objects) => appendFile(path, lines(objects)),
    catalog: (limits) =>
      write(
        join(home, ".claude", "cache", "model-catalog", "org-0a1b2c-ccd.json"),
        JSON.stringify({ catalog: { config: { models: Object.entries(limits).map(([id, max]) => ({ id, runtime: { max_input_tokens: max } })) } } }),
      ),
    async focus(ms, id) {
      await mkdir(logs, { recursive: true });
      const stamp = logStamp(ms);
      await appendFile(
        join(logs, "main.log"),
        `${stamp} [info] [CCD] LocalSessions.refresh: 3 sessions\n${stamp} [info] [CCD] LocalSessions.setFocusedSession: sessionId=${id ?? "null"}\n`,
      );
    },
    async rotateLog() {
      await rm(join(logs, "main1.log"), { force: true });
      await rename(join(logs, "main.log"), join(logs, "main1.log"));
    },
    removeLogs: () => rm(logs, { recursive: true, force: true }),
    /**
     * Writes a response into the app's HTTP cache, under the file name Chromium gives `url`.
     * `holds` puts another URL's key in that file.
     */
    async usage(url, { holds = url, mtime, ...file } = {}) {
      const path = join(cacheData, cacheFileName(url));
      await write(path, cacheFile({ url: holds, ...file }));
      if (mtime !== undefined) await setMtime(path, mtime);
    },
    removeUsage: (url) => rm(join(cacheData, cacheFileName(url)), { force: true }),
  };
}

/** A pid that stays alive until the test ends. */
function livePid(t) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
  t.after(() => child.kill());
  return child.pid;
}

/** A pid that is certainly dead: a child that has already exited. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
}

const macOS = (home) => PLATFORMS.darwin({ home, path: "" });
// The reader tests pick from small sets, so they read with a limit of 5; the plugin passes SLOT_COUNT.
const readerFor = (home, options = {}) => new FactReader({ home, platform: macOS(home), limit: 5, ...options });
const factsById = ({ sessions }) => new Map(sessions.map((item) => [item.id, item]));
/** The ids read() returns, sorted, since the order of its sessions array means nothing. */
const sessionIds = async (reader) => (await reader.read()).sessions.map(({ id }) => id).sort();
const orderOf = async (reader) => (await reader.read()).order;

// --- board: pure -------------------------------------------------------------------------------

const RECENCY = { by: "recency", reversed: false };

function facts(n, fields = {}) {
  return { id: localId(n), title: `Session ${n}`, recencyAt: 1000 - n, createdAt: 1000 - n, lastTurnEdgeAt: null, seenThrough: null, live: null, context: null, ...fields };
}
const statusOf = (fields) => boardOf([facts(1, fields)], RECENCY)[0].status;
const fillOf = (context) => boardOf([facts(1, { context })], RECENCY)[0].fill;
const idsOf = (board) => board.map((tile) => tile?.id ?? null);
const slots = (...ns) => [...ns, ...Array(SLOT_COUNT - ns.length).fill(null)].map((n) => (n === null ? null : localId(n)));

/** Recency order 2 4 1 3, creation order 1 3 2 4: neither is the other, a reverse, or the id order. */
const timed = [
  facts(1, { recencyAt: 30, createdAt: 25 }),
  facts(2, { recencyAt: 50, createdAt: 7 }),
  facts(3, { recencyAt: 10, createdAt: 9 }),
  facts(4, { recencyAt: 40, createdAt: 5 }),
];

describe("board", () => {
  test("a permission wait outranks everything, including an unseen finished turn", () => {
    assert.equal(statusOf({ live: { state: "waiting", on: "permission" }, lastTurnEdgeAt: 500, seenThrough: 100 }), "permission");
  });

  test("a wait for anything other than a permission card is a question", () => {
    assert.equal(statusOf({ live: { state: "waiting", on: "other" }, lastTurnEdgeAt: 500, seenThrough: 100 }), "question");
  });

  test("busy and shell are both working, even with an unseen turn edge", () => {
    assert.equal(statusOf({ live: { state: "busy" }, lastTurnEdgeAt: 500, seenThrough: 100 }), "working");
    assert.equal(statusOf({ live: { state: "shell" }, lastTurnEdgeAt: 500, seenThrough: 100 }), "working");
  });

  test("not working with a turn edge after seenThrough is review", () => {
    assert.equal(statusOf({ live: { state: "idle" }, lastTurnEdgeAt: 401, seenThrough: 400 }), "review");
  });

  test("a turn edge at or before seenThrough, or no turn edge at all, is idle", () => {
    assert.equal(statusOf({ live: { state: "idle" }, lastTurnEdgeAt: 400, seenThrough: 400 }), "idle");
    assert.equal(statusOf({ live: { state: "idle" }, lastTurnEdgeAt: 300, seenThrough: 400 }), "idle");
    assert.equal(statusOf({ live: { state: "idle" }, lastTurnEdgeAt: null, seenThrough: 400 }), "idle");
    assert.equal(statusOf({ live: { state: "idle" }, lastTurnEdgeAt: null, seenThrough: null }), "idle");
  });

  test("a session with no live CLI is review or idle by the same edge rule", () => {
    assert.equal(statusOf({ live: null, lastTurnEdgeAt: 500, seenThrough: 400 }), "review");
    assert.equal(statusOf({ live: null, lastTurnEdgeAt: 300, seenThrough: 400 }), "idle");
  });

  test("seenThrough null counts as never seen", () => {
    assert.equal(statusOf({ live: null, lastTurnEdgeAt: 1, seenThrough: null }), "review");
  });

  test("recency order puts the newest recencyAt on slot 1 and the rest newest first; reversed puts it last", () => {
    assert.deepEqual(idsOf(boardOf(timed, { by: "recency", reversed: false })), slots(2, 4, 1, 3));
    assert.deepEqual(idsOf(boardOf(timed, { by: "recency", reversed: true })), slots(3, 1, 4, 2));
  });

  test("created order puts the newest createdAt on slot 1; reversed puts the oldest there", () => {
    assert.deepEqual(idsOf(boardOf(timed, { by: "created", reversed: false })), slots(1, 3, 2, 4));
    assert.deepEqual(idsOf(boardOf(timed, { by: "created", reversed: true })), slots(4, 2, 3, 1));
  });

  test("alpha order reads numbers in titles as numbers, A to Z; reversed is Z to A", () => {
    const titled = [facts(1, { title: "작업 10" }), facts(2, { title: "작업 2" }), facts(3, { title: "작업 9" }), facts(4, { title: "작업 1" })];
    assert.deepEqual(idsOf(boardOf(titled, { by: "alpha", reversed: false })), slots(4, 2, 3, 1));
    assert.deepEqual(idsOf(boardOf(titled, { by: "alpha", reversed: true })), slots(1, 3, 2, 4));
  });

  test("titles that compare equal as text go by code unit order, not by id", () => {
    const titled = [facts(1, { title: "작업 2" }), facts(2, { title: "작업 02" })];
    assert.deepEqual(idsOf(boardOf(titled, { by: "alpha", reversed: false })), slots(2, 1));
    assert.deepEqual(idsOf(boardOf(titled, { by: "alpha", reversed: true })), slots(1, 2));
  });

  test("sessions with equal sort keys sit in id order in both directions, whatever order they arrive in", () => {
    const tied = [3, 1, 5, 2, 4].map((n) => facts(n, { title: "같은 제목", recencyAt: 500, createdAt: 400 }));
    for (const by of ["recency", "created", "alpha"]) {
      for (const reversed of [false, true]) {
        assert.deepEqual(idsOf(boardOf(tied, { by, reversed })), slots(1, 2, 3, 4, 5), `${by}, reversed ${reversed}`);
        assert.deepEqual(idsOf(boardOf([...tied].reverse(), { by, reversed })), slots(1, 2, 3, 4, 5), `${by}, reversed ${reversed}, input reversed`);
      }
    }
  });

  test("eight sessions fill all eight slots in the sidebar's order", () => {
    const eight = Array.from({ length: 8 }, (_, index) => facts(index + 1));
    assert.deepEqual(idsOf(boardOf([...eight].reverse(), RECENCY)), [1, 2, 3, 4, 5, 6, 7, 8].map(localId));
  });

  test("fewer sessions than keys leave the trailing slots empty, and no sessions give the empty board", () => {
    assert.deepEqual(idsOf(boardOf([facts(2), facts(1)], RECENCY)), slots(1, 2));
    assert.equal(boardOf([], RECENCY).length, 8);
    assert.deepEqual(boardOf([], RECENCY), EMPTY_BOARD);
  });

  test("fill is the rounded percent of the limit, capped at 100", () => {
    assert.deepEqual(fillOf({ usedTokens: 370_000, limitTokens: 1_000_000 }), { kind: "percent", percent: 37 });
    assert.deepEqual(fillOf({ usedTokens: 994, limitTokens: 1000 }), { kind: "percent", percent: 99 });
    assert.deepEqual(fillOf({ usedTokens: 1_200_000, limitTokens: 1_000_000 }), { kind: "percent", percent: 100 });
  });

  test("fill is a token count when the limit is unknown, and unknown when there is no context", () => {
    assert.deepEqual(fillOf({ usedTokens: 312_000, limitTokens: null }), { kind: "tokens", tokens: 312_000 });
    assert.deepEqual(fillOf(null), { kind: "unknown" });
  });

  test("parseSlot accepts 1..8 and rejects 0, 9, strings, and missing values", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(parseSlot), [1, 2, 3, 4, 5, 6, 7, 8]);
    for (const value of [0, 9, 2.5, "1", null, undefined, {}]) assert.equal(parseSlot(value), null, `rejects ${JSON.stringify(value)}`);
  });
});

// --- usage: pure -------------------------------------------------------------------------------

describe("usage", () => {
  test("cacheFileName is Chromium's simple cache name for the URL", () => {
    assert.equal(cacheFileName("https://api.anthropic.com/api/oauth/usage"), "1fb45f05be27bc77_0");
  });

  test("cacheEntryOf reads the key, the still-encoded body, the content-encoding, and the date", () => {
    const entry = cacheEntryOf(cacheFile({ url: usageUrl("org"), encoding: "br", date: at(5) }));
    assert.equal(entry.key, `1/0/${usageUrl("org")}`);
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(entry.body)), usageResponse());
    assert.equal(entry.encoding, "br");
    assert.equal(entry.date, at(5));
  });

  test("cacheEntryOf takes a response with no content-encoding as identity, and one with no date as dateless", () => {
    const entry = cacheEntryOf(cacheFile({ url: usageUrl("org"), encoding: "identity" }));
    assert.equal(entry.encoding, "identity");
    assert.equal(entry.date, null);
    assert.deepEqual(JSON.parse(entry.body), usageResponse());
  });

  test("cacheEntryOf rejects a bad magic, a file cut inside its header or key, and a file with no EOF record", () => {
    const url = usageUrl("org");
    const whole = cacheFile({ url });
    assert.notEqual(cacheEntryOf(whole), null, "the whole file parses");
    assert.equal(cacheEntryOf(cacheFile({ url, magic: 0x0123456789abcdefn })), null, "bad magic");
    assert.equal(cacheEntryOf(whole.subarray(0, 20)), null, "cut inside the header");
    assert.equal(cacheEntryOf(whole.subarray(0, 24 + 10)), null, "cut inside the key");
    assert.equal(cacheEntryOf(cacheFile({ url, finished: false })), null, "no EOF record yet");
  });

  test("planUsageOf reads all from the weekly_all entry and fable from the Fable weekly_scoped entry", () => {
    assert.deepEqual(planUsageOf(usageResponse({ all: 46, fable: 33 }), at(1)), {
      fetchedAt: at(1),
      limits: { all: { percent: 46, resetsAt: RESETS_AT_MS }, fable: { percent: 33, resetsAt: RESETS_AT_MS } },
    });
    const sevenDayDisagrees = { ...usageResponse({ all: 46 }), seven_day: { utilization: 99, resets_at: RESETS_AT } };
    assert.equal(planUsageOf(sevenDayDisagrees, at(1)).limits.all.percent, 46, "weekly_all wins over seven_day");
  });

  test("planUsageOf gives fable null when no weekly_scoped entry is for Fable", () => {
    const json = usageResponse();
    json.limits[1].scope.model.display_name = "Opus";
    assert.equal(planUsageOf(json, at(1)).limits.fable, null, "a scoped limit for another model");
    json.limits.pop();
    assert.equal(planUsageOf(json, at(1)).limits.fable, null, "no scoped limit");
    assert.equal(planUsageOf(json, at(1)).limits.all.percent, 46, "all is still read");
  });

  test("planUsageOf reads all from seven_day when limits has no weekly_all entry", () => {
    const { seven_day } = usageResponse({ all: 52 });
    assert.deepEqual(planUsageOf({ seven_day }, at(1)).limits, { all: { percent: 52, resetsAt: RESETS_AT_MS }, fable: null });
    assert.deepEqual(planUsageOf({ seven_day, limits: [] }, at(1)).limits.all, { percent: 52, resetsAt: RESETS_AT_MS });
  });

  test("planUsageOf floors percents, clamps them to 0..100, and makes an unreadable reset time null", () => {
    const fable = { kind: "weekly_scoped", percent: 140, resets_at: RESETS_AT, scope: { model: { display_name: "Fable" } } };
    const json = { limits: [{ kind: "weekly_all", percent: 46.9, resets_at: "soon" }, fable] };
    assert.deepEqual(planUsageOf(json, at(1)).limits, { all: { percent: 46, resetsAt: null }, fable: { percent: 100, resetsAt: RESETS_AT_MS } });
    json.limits[0].percent = -3;
    assert.equal(planUsageOf(json, at(1)).limits.all.percent, 0);
  });

  test("planUsageOf returns null for a response with neither limits nor seven_day", () => {
    for (const json of [{}, { five_hour: null }, null, [], "usage"]) assert.equal(planUsageOf(json, at(1)), null, JSON.stringify(json));
  });

  test("parseWindow accepts all and fable and nothing else", () => {
    assert.deepEqual(["all", "fable"].map((value) => parseWindow(value)), ["all", "fable"]);
    assert.deepEqual([...USAGE_WINDOWS], ["all", "fable"]);
    for (const value of ["weekly", "Fable", "", null, undefined, 1, {}]) assert.equal(parseWindow(value), null, `rejects ${JSON.stringify(value)}`);
  });
});

describe("usage tiles", () => {
  const THIRTY_MINUTES = 30 * 60_000;
  const reading = (limits, fetchedAt = at(0)) => ({ fetchedAt, limits: { all: null, fable: null, ...limits } });

  test("no reading, or no limit for the window, is none", () => {
    assert.deepEqual(usageTileOf(null, "all", at(1)), { window: "all", kind: "none" });
    assert.deepEqual(usageTileOf(reading({ all: { percent: 46, resetsAt: at(100) } }), "fable", at(1)), { window: "fable", kind: "none" });
  });

  test("a reading is a limit until its reset time, and reset from that millisecond on", () => {
    const usage = reading({ all: { percent: 46, resetsAt: at(100) } });
    assert.deepEqual(usageTileOf(usage, "all", at(100) - 1), { window: "all", kind: "limit", percent: 46, resetsInMs: 1, staleForMs: null });
    assert.deepEqual(usageTileOf(usage, "all", at(100)), { window: "all", kind: "reset" });
  });

  test("a reading more than 30 minutes old carries its age; one exactly 30 minutes old does not", () => {
    const usage = reading({ fable: { percent: 33, resetsAt: at(0) + DAY_MS } });
    assert.equal(usageTileOf(usage, "fable", at(0) + THIRTY_MINUTES).staleForMs, null);
    assert.equal(usageTileOf(usage, "fable", at(0) + THIRTY_MINUTES + 1).staleForMs, THIRTY_MINUTES + 1);
    assert.equal(usageTileOf(usage, "fable", at(0) + THIRTY_MINUTES + 1).resetsInMs, DAY_MS - THIRTY_MINUTES - 1);
  });

  test("an unknown reset time never resets and has no remaining time", () => {
    const usage = reading({ all: { percent: 46, resetsAt: null } });
    assert.deepEqual(usageTileOf(usage, "all", at(0) + 30 * DAY_MS), { window: "all", kind: "limit", percent: 46, resetsInMs: null, staleForMs: 30 * DAY_MS });
  });
});

// --- face: pure --------------------------------------------------------------------------------

const svgOf = (dataUrl) => {
  assert.ok(dataUrl.startsWith("data:image/svg+xml;base64,"), "an SVG data URL");
  return Buffer.from(dataUrl.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
};
const textsOf = (svg) => [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map(([, attributes, content]) => ({ attributes, content }));
const titleLines = (svg) => textsOf(svg).filter(({ attributes }) => / y="(78|106)"/.test(attributes)).map(({ content }) => content);
const fillText = (svg) => textsOf(svg).find(({ attributes }) => attributes.includes('text-anchor="end"'));
const tileWith = (fields = {}) => ({ id: localId(1), title: "덱 세션 키", status: "idle", fill: { kind: "unknown" }, ...fields });
const firstFrame = (tile) => renderFrames(tile)[0];
/** Each <rect>'s attributes by name. */
const rectsOf = (svg) => [...svg.matchAll(/<rect([^>]*)\/>/g)].map(([, attributes]) => Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])));
/** The SVG with every color and every text's content taken out: what is drawn where, at what size. */
const layoutOf = (svg) => svg.replace(/ fill="#[0-9A-F]{6}"/g, "").replace(/>[^<]*<\/text>/g, "></text>");
const colorOf = (attributes) => attributes.match(/fill="(#[0-9A-F]{6})"/)[1];

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const usageTile = (fields = {}) => ({ window: "all", kind: "limit", percent: 46, resetsInMs: DAY_MS + 10 * HOUR_MS, staleForMs: null, ...fields });
const usageSvg = (fields) => svgOf(renderUsage(usageTile(fields)));
/** One tile of each kind for each window. */
const USAGE_TILES = USAGE_WINDOWS.flatMap((window) => [
  usageTile({ window }),
  usageTile({ window, staleForMs: 2 * HOUR_MS, resetsInMs: null, percent: 90 }),
  { window, kind: "reset" },
  { window, kind: "none" },
]);

describe("face", () => {
  test("the same tile renders to the same frames", () => {
    const tile = tileWith({ status: "permission", fill: { kind: "percent", percent: 42 } });
    assert.deepEqual(renderFrames(tile), renderFrames({ ...tile, fill: { ...tile.fill } }));
  });

  test("permission and question flash two different frames; working, review, idle, and an empty slot hold one", () => {
    const counts = Object.fromEntries(STATUSES.map((status) => [status, renderFrames(tileWith({ status })).length]));
    assert.deepEqual(counts, FRAME_COUNTS);
    for (const status of ["permission", "question"]) {
      const [face, flash] = renderFrames(tileWith({ status }));
      assert.notEqual(face, flash, `${status} frames differ`);
    }
    assert.equal(renderFrames(null).length, 1);
  });

  test("every status in STATUSES renders its label, and each renders differently for the same session", () => {
    const images = STATUSES.map((status) => firstFrame(tileWith({ status })));
    assert.equal(new Set(images).size, STATUSES.length);
    STATUSES.forEach((status, index) => {
      assert.ok(textsOf(svgOf(images[index])).some(({ content }) => content === LABELS[status]), `${status} shows ${LABELS[status]}`);
    });
  });

  test("the first frame of every status is the same face; only the colors and the label differ", () => {
    const fill = { kind: "percent", percent: 37 };
    const idle = layoutOf(svgOf(firstFrame(tileWith({ status: "idle", fill }))));
    for (const status of STATUSES) assert.equal(layoutOf(svgOf(firstFrame(tileWith({ status, fill })))), idle, status);
  });

  test("the second frame fills the key with the band color and shows the label larger, with the title and fill where the face has them", () => {
    for (const status of ["permission", "question"]) {
      const [face, flash] = renderFrames(tileWith({ status, title: "Fix the session keys", fill: { kind: "percent", percent: 37 } })).map(svgOf);
      const band = rectsOf(face).find((rect) => rect.height === "48").fill;
      const background = rectsOf(face).find((rect) => rect.width === "196" && rect.height === "196");
      assert.deepEqual(rectsOf(flash)[0], { ...background, fill: band }, `${status} paints the whole key in its band color`);
      const label = (svg) => textsOf(svg).find(({ content }) => content === LABELS[status]);
      const size = (svg) => Number(label(svg).attributes.match(/font-size="(\d+)"/)[1]);
      assert.ok(size(flash) > size(face), `${status} label is larger`);
      const placed = (svg) => textsOf(svg).filter(({ content }) => content !== LABELS[status]).map(({ attributes, content }) => [content, attributes.replace(/ fill="#[0-9A-F]{6}"/, "")]);
      assert.deepEqual(placed(flash), placed(face), `${status} title and fill stay in place`);
      assert.deepEqual(titleLines(flash), ["Fix the", "session keys"]);
      assert.equal(fillText(flash).content, "37%");
    }
  });

  test("the empty slot renders a blank tile with no text", () => {
    const svg = svgOf(firstFrame(null));
    assert.equal(textsOf(svg).length, 0);
    assert.equal(svg.match(/<rect/g).length, 1);
  });

  test("titles with & < > and quotes are escaped in every frame", () => {
    for (const status of STATUSES) {
      for (const svg of renderFrames(tileWith({ status, title: `a&b <c> "d" 'e'` })).map(svgOf)) {
        assert.equal(titleLines(svg).join(" "), "a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;", status);
        assert.ok(!svg.includes("<c>"), `no raw tag from the title (${status})`);
      }
    }
  });

  test("a long Korean title with no spaces wraps to two lines and ends with an ellipsis", () => {
    const title = "세션키상태표시를덱에서확인하는아주긴제목입니다";
    const [first, second, ...more] = titleLines(svgOf(firstFrame(tileWith({ title }))));
    assert.equal(more.length, 0, "two lines at most");
    assert.ok(title.startsWith(first) && first.length > 0);
    assert.ok(second.endsWith("…"));
    assert.ok(title.startsWith(first + second.slice(0, -1)), "line two continues line one");
    // 168 px of title width holds 7 Hangul glyphs at 24 px.
    assert.ok([...first].length <= 7 && [...second].length <= 7, "each line fits the key");
  });

  test("a Latin title breaks at a space, and a short title stays on one line", () => {
    const title = "Fix the session keys";
    const [first, second] = titleLines(svgOf(firstFrame(tileWith({ title }))));
    assert.ok(title.startsWith(first + " "), "line one ends at a word boundary");
    assert.equal(`${first} ${second}`, title, "line two is the rest, uncut");
    assert.deepEqual(titleLines(svgOf(firstFrame(tileWith({ title: "Short" })))), ["Short"]);
  });

  test("percent, token, and unknown fills read 37%, 312k, and a dash; only percent draws a bar", () => {
    const percent = svgOf(firstFrame(tileWith({ fill: { kind: "percent", percent: 37 } })));
    const tokens = svgOf(firstFrame(tileWith({ fill: { kind: "tokens", tokens: 312_000 } })));
    const unknown = svgOf(firstFrame(tileWith({ fill: { kind: "unknown" } })));
    assert.equal(fillText(percent).content, "37%");
    assert.equal(fillText(tokens).content, "312k");
    assert.equal(fillText(unknown).content, "—");
    assert.ok(percent.includes('fill="#2B2F36"'), "percent draws the bar track");
    assert.ok(!tokens.includes('fill="#2B2F36"') && !unknown.includes('fill="#2B2F36"'), "tokens and unknown draw no bar");
  });

  test("the fill turns amber at 60% and red at 85%", () => {
    const colorAt = (percent) => fillText(svgOf(firstFrame(tileWith({ fill: { kind: "percent", percent } })))).attributes.match(/fill="(#[0-9A-F]{6})"/)[1];
    assert.deepEqual([59, 60, 84, 85, 100].map(colorAt), ["#E6E8EB", "#E3B341", "#E3B341", "#F85149", "#F85149"]);
  });

  test("every frame, session and usage, avoids what Qt drops: 8-digit hex colors, dominant-baseline, filter, clip-path, font-weight", () => {
    const fills = [{ kind: "percent", percent: 90 }, { kind: "tokens", tokens: 1_234_567 }, { kind: "unknown" }];
    const sessionFrames = STATUSES.flatMap((status) => fills.flatMap((fill) => renderFrames(tileWith({ status, fill }))));
    for (const svg of [...sessionFrames, ...USAGE_TILES.map(renderUsage)].map(svgOf)) {
      assert.ok(svg.includes('width="196" height="196"'), "the 196 canvas");
      assert.ok(!/#[0-9a-fA-F]{8}\b/.test(svg), "no 8-digit hex color");
      for (const word of ["dominant-baseline", "filter", "clip-path", "font-weight"]) assert.ok(!svg.includes(word), `no ${word}`);
    }
  });

  test("the same usage tile renders to the same frame", () => {
    for (const tile of USAGE_TILES) assert.equal(renderUsage(tile), renderUsage({ ...tile }));
  });

  test("a usage key names its window on the band: 주간 전체 in white on violet, 주간 Fable in dark on yellow", () => {
    const looks = { all: ["주간 전체", "#6E56CF", "#FFFFFF"], fable: ["주간 Fable", "#FFC23D", "#17191D"] };
    for (const [window, [label, band, ink]] of Object.entries(looks)) {
      for (const tile of USAGE_TILES.filter((item) => item.window === window)) {
        const svg = svgOf(renderUsage(tile));
        const text = textsOf(svg).find(({ content }) => content === label);
        assert.ok(text, `${window} ${tile.kind} shows ${label}`);
        assert.equal(colorOf(text.attributes), ink, `${window} label ink`);
        assert.equal(rectsOf(svg).find((rect) => rect.height === "48").fill, band, `${window} band`);
      }
    }
  });

  test("a usage key is drawn on the session face's layout: band, two lines where the title goes, percent and bar where the fill goes", () => {
    const session = firstFrame(tileWith({ title: "Fix the session keys", fill: { kind: "percent", percent: 46 } }));
    assert.equal(layoutOf(usageSvg({})), layoutOf(svgOf(session)));
  });

  test("a limit shows 초기화까지, the time to its reset, and its percent with the bar", () => {
    const svg = usageSvg({});
    assert.deepEqual(titleLines(svg), ["초기화까지", "1일 10시간"]);
    assert.equal(colorOf(textsOf(svg).find(({ content }) => content === "초기화까지").attributes), "#E6E8EB");
    assert.equal(fillText(svg).content, "46%");
    assert.ok(svg.includes('fill="#2B2F36"'), "the bar track");
  });

  test("the time to the reset floors to minutes and leaves out a zero second unit", () => {
    const lineOf = (ms) => titleLines(usageSvg({ resetsInMs: ms }))[1];
    const times = [DAY_MS + 10 * HOUR_MS + 59 * MINUTE_MS + 59_000, 2 * DAY_MS + 30 * MINUTE_MS, 3 * HOUR_MS + 20 * MINUTE_MS + 59_000, 5 * HOUR_MS, 45 * MINUTE_MS + 30_000];
    assert.deepEqual(times.map(lineOf), ["1일 10시간", "2일", "3시간 20분", "5시간", "45분"]);
  });

  test("an unknown reset time reads 시각 모름", () => {
    assert.deepEqual(titleLines(usageSvg({ resetsInMs: null })), ["초기화까지", "시각 모름"]);
  });

  test("a stale reading shows its age in amber in place of 초기화까지", () => {
    const svg = usageSvg({ staleForMs: 2 * HOUR_MS + 5 * MINUTE_MS });
    assert.deepEqual(titleLines(svg), ["2시간 전 값", "1일 10시간"]);
    assert.equal(colorOf(textsOf(svg).find(({ content }) => content === "2시간 전 값").attributes), "#E3B341");
    assert.equal(titleLines(usageSvg({ staleForMs: 31 * MINUTE_MS + 59_000 }))[0], "31분 전 값");
  });

  test("the usage percent turns amber at 60% and red at 85%", () => {
    const colorAt = (percent) => colorOf(fillText(usageSvg({ percent })).attributes);
    assert.deepEqual([59, 60, 85].map(colorAt), ["#E6E8EB", "#E3B341", "#F85149"]);
  });

  test("a reset reads 초기화됨 and 새 값 없음 over a dash; none reads 값 없음 over a dash; neither draws a bar", () => {
    const reset = svgOf(renderUsage({ window: "fable", kind: "reset" }));
    const none = svgOf(renderUsage({ window: "all", kind: "none" }));
    assert.deepEqual(titleLines(reset), ["초기화됨", "새 값 없음"]);
    assert.deepEqual(titleLines(none), ["값 없음"]);
    for (const svg of [reset, none]) {
      assert.equal(fillText(svg).content, "—");
      assert.ok(!svg.includes('fill="#2B2F36"'), "no bar");
    }
  });

  test("the longest usage lines fit the 7 ems a title line has at size 24", () => {
    // The face's width table: Hangul one em, Latin capitals and digits 0.65, a space 0.3, the rest 0.55.
    const ems = (line) => [...line].reduce((sum, char) => sum + (/[가-힣]/.test(char) ? 1 : char === " " ? 0.3 : /[A-Z0-9]/.test(char) ? 0.65 : 0.55), 0);
    const lines = [
      ...titleLines(usageSvg({ resetsInMs: 6 * DAY_MS + 23 * HOUR_MS + 59 * MINUTE_MS, staleForMs: 999 * HOUR_MS })),
      ...titleLines(usageSvg({ resetsInMs: 23 * HOUR_MS + 59 * MINUTE_MS, staleForMs: 59 * MINUTE_MS })),
      ...USAGE_TILES.flatMap((tile) => titleLines(svgOf(renderUsage(tile)))),
    ];
    assert.ok(lines.includes("6일 23시간") && lines.includes("999시간 전 값") && lines.includes("23시간 59분"), "the long cases were drawn");
    for (const line of lines) assert.ok(ems(line) <= 7, `${line} is ${ems(line)} ems`);
  });
});

// --- files: temp folder ------------------------------------------------------------------------

async function tempFile(t, content) {
  const dir = await mkdtemp(join(tmpdir(), "claude-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "file");
  if (content !== undefined) await writeFile(path, content);
  return path;
}

describe("files", () => {
  test("readLinesFrom returns only newline-terminated lines and an end at the last newline", async (t) => {
    const path = await tempFile(t, "a\nbé\npartial");
    const read = await readLinesFrom(path, 0);
    assert.deepEqual(read.lines, ["a", "bé"]);
    assert.equal(read.cursor.end, Buffer.byteLength("a\nbé\n"));
  });

  test("readLinesFrom from a previous end returns only the appended lines", async (t) => {
    const path = await tempFile(t, "a\nb\npart");
    const first = await readLinesFrom(path, 0);
    await appendFile(path, "ial\nc\n");
    const second = await readLinesFrom(path, first.cursor.end);
    assert.deepEqual(second.lines, ["partial", "c"]);
    assert.equal(second.cursor.end, Buffer.byteLength("a\nb\npartial\nc\n"));
  });

  test("readLinesFrom returns null for a missing file", async (t) => {
    assert.equal(await readLinesFrom(await tempFile(t), 0), null);
  });

  test("findLastLine finds the last wanted line when it is in the first 64 KB chunk", async (t) => {
    const path = await tempFile(t, "x1\nwant1\nx2\nwant2\nx3\n");
    const found = await findLastLine(path, (line) => line.startsWith("want"));
    assert.equal(found.offset, "x1\nwant1\nx2\n".length);
  });

  test("findLastLine reads a wanted line longer than several chunks whole", async (t) => {
    const long = "want" + "a".repeat(300_000);
    const head = "x\n".repeat(50_000);
    const path = await tempFile(t, `${head}${long}\nx\nx\n`);
    const found = await findLastLine(path, (line) => line.startsWith("want") && line.length === long.length);
    assert.equal(found.offset, head.length);
    assert.equal((await readLinesFrom(path, found.offset)).lines[0], long);
  });

  test("findLastLine skips a trailing line that has no newline yet", async (t) => {
    const path = await tempFile(t, "want1\nwant2");
    assert.equal((await findLastLine(path, (line) => line.startsWith("want"))).offset, 0);
  });

  test("findLastLine returns offset 0 when no line is wanted, and null for a missing file", async (t) => {
    assert.equal((await findLastLine(await tempFile(t, "a\nb\nc\n"), () => false)).offset, 0);
    assert.equal(await findLastLine(await tempFile(t), () => true), null);
  });

  test("JsonFiles keeps the last good value when the file turns into bad JSON, and rereads it next time", async (t) => {
    const path = await tempFile(t, '{"v":1}');
    const files = new JsonFiles((json) => json.v);
    assert.equal(await files.get(path, await stat(path)), 1);
    await writeFile(path, '{"v":3 ');
    await utimes(path, 1_000_000, 1_000_000);
    const half = await stat(path);
    assert.equal(await files.get(path, half), 1, "half-written JSON keeps the last good value");
    await writeFile(path, '{"v":3}');
    await utimes(path, 1_000_000, 1_000_000);
    const whole = await stat(path);
    assert.equal(`${whole.ino}:${whole.size}:${whole.mtimeMs}`, `${half.ino}:${half.size}:${half.mtimeMs}`, "same identity as the half-written file");
    assert.equal(await files.get(path, whole), 3, "the next read parses again");
  });

  test("JsonFiles does not reread a file whose stamp is unchanged", async (t) => {
    const path = await tempFile(t, '{"v":1}');
    let parses = 0;
    const files = new JsonFiles((json) => (parses++, json.v));
    const stats = await stat(path);
    await files.get(path, stats);
    await files.get(path, stats);
    assert.equal(parses, 1);
    await writeFile(path, '{"v":22}');
    assert.equal(await files.get(path, await stat(path)), 22);
    assert.equal(parses, 2);
  });
});

// --- reader: FactReader against a fake home ----------------------------------------------------

describe("reader", () => {
  test("returns the five non-archived sessions with the newest activity, not the newest file mtimes", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 7; n++) {
      await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n), isArchived: n === 7 }, { mtime: at(100 - n) });
    }
    assert.deepEqual(await sessionIds(readerFor(home.home)), [2, 3, 4, 5, 6].map(localId));
  });

  test("a session whose last turn edge is newer than another's last activity wins the fifth place, though its own last activity is older", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 5; n++) await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n * 10) });
    await home.session({ id: localId(6), title: "S6", lastActivityAt: at(5), lastTurnEdgeAt: at(15) });
    assert.deepEqual(await sessionIds(readerFor(home.home)), [2, 3, 4, 5, 6].map(localId));
  });

  test("the five are the newest by recency time even when the sidebar sorts by creation", async (t) => {
    const home = await fakeHome(t);
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "created", ascending: false } }));
    await home.session({ id: localId(1), title: "made first, active last", createdAt: at(1), lastActivityAt: at(100) });
    for (let n = 2; n <= 6; n++) await home.session({ id: localId(n), title: `S${n}`, createdAt: at(n * 10), lastActivityAt: at(n * 10) });
    assert.deepEqual(await sessionIds(readerFor(home.home)), [1, 3, 4, 5, 6].map(localId));
  });

  test("recencyAt is the last turn edge, else the last activity; createdAt is the file's, else the last activity, unless that is not positive or after recencyAt", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "kept", lastActivityAt: at(9), createdAt: at(3) });
    await home.session({ id: localId(2), title: "after recency", lastActivityAt: at(9), createdAt: at(20) });
    await home.session({ id: localId(3), title: "zero", lastActivityAt: at(9), createdAt: 0 });
    await home.session({ id: localId(4), title: "missing", lastActivityAt: at(4), lastTurnEdgeAt: at(9) });
    await home.session({ id: localId(5), title: "after an older turn edge", lastActivityAt: at(9), lastTurnEdgeAt: at(5), createdAt: at(7) });
    const facts = factsById(await readerFor(home.home).read());
    const times = (n) => [facts.get(localId(n)).recencyAt, facts.get(localId(n)).createdAt];
    assert.deepEqual(times(1), [at(9), at(3)]);
    assert.deepEqual(times(2), [at(9), at(9)], "createdAt after recencyAt");
    assert.deepEqual(times(3), [at(9), at(9)], "createdAt zero");
    assert.deepEqual(times(4), [at(9), at(4)], "createdAt missing uses lastActivityAt");
    assert.deepEqual(times(5), [at(5), at(5)], "an older lastTurnEdgeAt still wins over lastActivityAt");
  });

  test("reads only the account folder with the newest mtime", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "old account", lastActivityAt: at(9) }, { account: "old/org" });
    await home.session({ id: localId(2), title: "new account", lastActivityAt: at(1) }, { account: "new/org" });
    await home.touchAccount("old/org", at(100));
    await home.touchAccount("new/org", at(200));
    assert.deepEqual(await sessionIds(readerFor(home.home)), [localId(2)]);
  });

  test("after every mtime jumps (app restart) it returns the same five sessions", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 6; n++) await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n) }, { mtime: at(10 + ((n * 4) % 6)) });
    const reader = readerFor(home.home);
    const before = await sessionIds(reader);
    for (let n = 1; n <= 6; n++) await home.touchSession(localId(n), Date.now());
    assert.deepEqual(await sessionIds(reader), before);
    assert.deepEqual(before, [2, 3, 4, 5, 6].map(localId));
  });

  test("a file whose mtime equals the fifth session's recency time is still read, and wins the tie by id", async (t) => {
    const home = await fakeHome(t);
    for (const [n, seconds] of [[11, 50], [12, 40], [13, 30], [14, 20], [15, 10]]) {
      await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(seconds) }, { mtime: at(100) });
    }
    await home.session({ id: localId(1), title: "tie", lastActivityAt: at(10) }, { mtime: at(10) });
    assert.deepEqual(await sessionIds(readerFor(home.home)), [1, 11, 12, 13, 14].map(localId));
  });

  test("a corrupt session file keeps its last good record and does not drop the others", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 3; n++) await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n) });
    const reader = readerFor(home.home);
    const before = await reader.read();
    await home.corruptSession(localId(2));
    assert.deepEqual(await reader.read(), before);
  });

  test("a corrupt session file seen for the first time is left out and the rest are returned", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 3; n++) await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n) });
    await home.corruptSession(localId(3));
    assert.deepEqual(await sessionIds(readerFor(home.home)), [localId(1), localId(2)]);
  });

  test("unknown fields are ignored and a missing title falls back to the cwd's last folder, then to 새 세션", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), lastActivityAt: at(1), cwd: "/Users/someone/my-project", extra: { nested: [1, 2] } });
    await home.session({ id: localId(2), title: "  ", lastActivityAt: at(2), cwd: null });
    const facts = factsById(await readerFor(home.home).read());
    assert.equal(facts.get(localId(1)).title, "my-project");
    assert.equal(facts.get(localId(2)).title, "새 세션");
  });

  test("live status comes from the entry whose hostSessionId matches the session", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(2) });
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(1) });
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "busy", statusUpdatedAt: at(3) });
    const facts = factsById(await readerFor(home.home).read());
    assert.deepEqual(facts.get(localId(1)).live, { state: "busy" });
    assert.equal(facts.get(localId(2)).live, null);
  });

  test("entries with a dead pid or without hostSessionId are ignored", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.registry({ pid: await deadPid(), hostSessionId: localId(1), sessionId: cliId(1), status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: at(3) });
    await home.registry({ pid: process.pid, sessionId: cliId(9), status: "busy", statusUpdatedAt: at(4) });
    assert.equal((await readerFor(home.home).read()).sessions[0].live, null);
  });

  test("a registry file rewritten without hostSessionId drops its old status at once", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: at(3) });
    const reader = readerFor(home.home);
    assert.deepEqual((await reader.read()).sessions[0].live, { state: "waiting", on: "permission" });
    await home.registry({ pid: process.pid, sessionId: cliId(1), status: "idle", statusUpdatedAt: at(5) });
    assert.equal((await reader.read()).sessions[0].live, null);
  });

  test("waitingFor 'permission prompt' is a permission wait, any other reason is another wait, and an unknown status is no status", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    const reader = readerFor(home.home);
    const liveWith = async (fields, seconds) => {
      await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), statusUpdatedAt: at(seconds), ...fields });
      return (await reader.read()).sessions[0].live;
    };
    assert.deepEqual(await liveWith({ status: "waiting", waitingFor: "permission prompt" }, 2), { state: "waiting", on: "permission" });
    assert.deepEqual(await liveWith({ status: "waiting", waitingFor: "input needed" }, 3), { state: "waiting", on: "other" });
    assert.deepEqual(await liveWith({ status: "waiting", waitingFor: "something new" }, 4), { state: "waiting", on: "other" });
    assert.equal(await liveWith({ status: "napping" }, 5), null, "an unknown status does not keep the earlier wait");
  });

  test("never opens *.key files: a .key file holding a waiting entry changes nothing", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    const entry = { pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: at(2) };
    await home.registryKeyFile(process.pid, JSON.stringify(entry));
    assert.equal((await readerFor(home.home).read()).sessions[0].live, null);
  });

  test("an empty or missing registry folder (app restart) gives live null for every session", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "busy", statusUpdatedAt: at(2) });
    const reader = readerFor(home.home);
    assert.deepEqual((await reader.read()).sessions[0].live, { state: "busy" });
    await home.emptyRegistry();
    assert.equal((await reader.read()).sessions[0].live, null, "empty folder");
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "busy", statusUpdatedAt: at(3) });
    assert.deepEqual((await reader.read()).sessions[0].live, { state: "busy" });
    await home.removeRegistry();
    assert.equal((await reader.read()).sessions[0].live, null, "missing folder");
  });

  test("of two live entries for one session, the newer statusUpdatedAt wins", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "idle", statusUpdatedAt: at(5) });
    await home.registry({ pid: livePid(t), hostSessionId: localId(1), sessionId: cliId(2), status: "busy", statusUpdatedAt: at(9) });
    assert.deepEqual((await readerFor(home.home).read()).sessions[0].live, { state: "busy" });
  });

  test("context is input + cache read + cache creation of the last main-chain assistant line", async (t) => {
    const home = await fakeHome(t);
    await home.catalog({ "claude-opus-5-5": 1_000_000 });
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    await home.transcript("/work/deck", cliId(1), [reply(100_000), userLine(), reply(200_000), userLine()]);
    assert.deepEqual((await readerFor(home.home).read()).sessions[0].context, { usedTokens: 200_000, limitTokens: 1_000_000 });
  });

  test("lines of one response that repeat the same usage are not summed", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    const path = await home.transcript("/work/deck", cliId(1), [userLine(), reply(150_000), reply(150_000), reply(150_000)]);
    const reader = readerFor(home.home);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 150_000, "on first sight");
    await home.appendTranscript(path, [userLine(), reply(180_000)]);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 180_000);
    await home.appendTranscript(path, [reply(180_000), reply(180_000)]);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 180_000, "when the rest of a response is appended later");
  });

  test("a compact_boundary after the last assistant line sets usedTokens to postTokens", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    const path = await home.transcript("/work/deck", cliId(1), [reply(800_000), compact(40_000), metadata()]);
    const reader = readerFor(home.home);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 40_000);
    await home.appendTranscript(path, [reply(800_000), compact(35_000)]);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 35_000, "a compaction appended later is folded the same way");
  });

  test("sidechain lines, <synthetic> lines, and trailing metadata lines are skipped", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    await home.transcript("/work/deck", cliId(1), [reply(120_000), reply(900_000, { sidechain: true }), reply(5_000, { model: "<synthetic>" }), metadata(), metadata()]);
    assert.equal((await readerFor(home.home).read()).sessions[0].context.usedTokens, 120_000);
  });

  test("the transcript follows the registry's CLI id when it differs from the desktop file's", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    await home.transcript("/work/deck", cliId(1), [reply(100_000)]);
    await home.transcript("/work/deck", cliId(2), [reply(300_000)]);
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(2), status: "idle", statusUpdatedAt: at(2) });
    assert.equal((await readerFor(home.home).read()).sessions[0].context.usedTokens, 300_000);
  });

  test("a transcript whose folder is not the guessed slug is found by searching the projects folders", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    await home.transcript("/work/deck", cliId(1), [reply(70_000)], { folder: "-work-deck-truncated-a1b2c3" });
    assert.equal((await readerFor(home.home).read()).sessions[0].context.usedTokens, 70_000);
  });

  test("a transcript that does not exist yet gives context null, and is picked up once it appears", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    const reader = readerFor(home.home);
    assert.equal((await reader.read()).sessions[0].context, null);
    await home.transcript("/work/deck", cliId(1), [reply(30_000)]);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 30_000);
  });

  test("appended lines update the context; bytes already folded are not read again", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    const path = await home.transcript("/work/deck", cliId(1), [reply(150_000)]);
    const reader = readerFor(home.home);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 150_000);
    const rewritten = JSON.stringify(reply(950_000));
    assert.equal(rewritten.length, JSON.stringify(reply(150_000)).length);
    const handle = await open(path, "r+");
    await handle.write(rewritten, 0);
    await handle.close();
    await home.appendTranscript(path, [metadata()]);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 150_000, "an append without usage leaves the folded value");
    await home.appendTranscript(path, [reply(250_000)]);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 250_000);
  });

  test("a transcript that is replaced or truncated is scanned again from its end", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1) });
    const path = await home.transcript("/work/deck", cliId(1), [reply(400_000), userLine(), userLine()]);
    const reader = readerFor(home.home);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 400_000);
    await writeFile(`${path}.new`, [reply(50_000), userLine()].map((line) => JSON.stringify(line) + "\n").join(""));
    await rename(`${path}.new`, path);
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 50_000, "replaced");
    await writeFile(path, JSON.stringify(reply(9_000)) + "\n");
    assert.equal((await reader.read()).sessions[0].context.usedTokens, 9_000, "truncated in place");
  });

  test("limitTokens comes from runtime.max_input_tokens and is null for a model missing from the catalog", async (t) => {
    const home = await fakeHome(t);
    await home.catalog({ "claude-opus-5-5": 1_000_000, "claude-haiku-4-5-20251001": 200_000 });
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(2), cliSessionId: cliId(1) });
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(1), cliSessionId: cliId(2), model: "claude-new-9" });
    await home.transcript("/work/deck", cliId(1), [reply(50_000, { model: "claude-haiku-4-5-20251001" })]);
    await home.transcript("/work/deck", cliId(2), [reply(50_000, { model: "claude-new-9" })]);
    const facts = factsById(await readerFor(home.home).read());
    assert.equal(facts.get(localId(1)).context.limitTokens, 200_000);
    assert.equal(facts.get(localId(2)).context.limitTokens, null);
  });

  test("the transcript's model wins over the desktop file's model for the limit", async (t) => {
    const home = await fakeHome(t);
    await home.catalog({ "claude-opus-5-5": 1_000_000, "claude-haiku-4-5-20251001": 200_000 });
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), cliSessionId: cliId(1), model: "claude-haiku-4-5-20251001" });
    await home.transcript("/work/deck", cliId(1), [reply(50_000, { model: "claude-opus-5-5" })]);
    assert.equal((await readerFor(home.home).read()).sessions[0].context.limitTokens, 1_000_000);
  });

  test("the selected session is seen through now", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.focus(at(10), localId(1));
    const now = at(500) + 123;
    assert.equal((await readerFor(home.home, { now: () => now }).read()).sessions[0].seenThrough, now);
  });

  test("a session that was left is seen through the second it was left, to the last millisecond", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(2) });
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(1) });
    await home.focus(at(10), localId(1));
    await home.focus(at(20), null);
    await home.focus(at(20), localId(2));
    const facts = factsById(await readerFor(home.home, { now: () => at(500) }).read());
    assert.equal(facts.get(localId(1)).seenThrough, at(20) + 999);
    assert.equal(facts.get(localId(2)).seenThrough, at(500));
  });

  test("a lone null ends the previous selection and selects nothing", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(2) });
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(1) });
    await home.focus(at(10), localId(1));
    await home.focus(at(30), null);
    const facts = factsById(await readerFor(home.home, { now: () => at(500) }).read());
    assert.equal(facts.get(localId(1)).seenThrough, at(30) + 999);
    assert.equal(facts.get(localId(2)).seenThrough, null);
  });

  test("selection lines written just before a rotation are read from main1.log", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 3; n++) await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n) });
    await home.focus(at(10), localId(1));
    const reader = readerFor(home.home, { now: () => at(500) });
    await reader.read();
    await home.focus(at(20), localId(2));
    await home.rotateLog();
    await home.focus(at(40), null);
    await home.focus(at(40), localId(3));
    const facts = factsById(await reader.read());
    assert.equal(facts.get(localId(1)).seenThrough, at(20) + 999, "left when session 2 was selected before the rotation");
    assert.equal(facts.get(localId(2)).seenThrough, at(40) + 999);
    assert.equal(facts.get(localId(3)).seenThrough, at(500));
  });

  test("at start it reads main1.log and then main.log", async (t) => {
    const home = await fakeHome(t);
    for (let n = 1; n <= 3; n++) await home.session({ id: localId(n), title: `S${n}`, lastActivityAt: at(n) });
    await home.focus(at(10), localId(1));
    await home.focus(at(20), localId(2));
    await home.rotateLog();
    await home.focus(at(30), localId(3));
    const facts = factsById(await readerFor(home.home, { now: () => at(500) }).read());
    assert.equal(facts.get(localId(1)).seenThrough, at(20) + 999);
    assert.equal(facts.get(localId(2)).seenThrough, at(30) + 999);
    assert.equal(facts.get(localId(3)).seenThrough, at(500));
  });

  test("with no selection lines for a session, seenThrough falls back to lastFocusedAt, and the later of the two wins", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(2), lastFocusedAt: at(60) });
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(1), lastFocusedAt: at(5) });
    await home.focus(at(10), localId(1));
    await home.focus(at(20), null);
    const facts = factsById(await readerFor(home.home, { now: () => at(500) }).read());
    assert.equal(facts.get(localId(1)).seenThrough, at(60));
    assert.equal(facts.get(localId(2)).seenThrough, at(5));
  });

  test("a missing log leaves seenThrough at lastFocusedAt and does not fail the read", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), lastFocusedAt: at(7) });
    const { sessions } = await readerFor(home.home).read();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].seenThrough, at(7));
  });

  test("while the log cannot be read, the selected session stays seen through the last successful read", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.focus(at(10), localId(1));
    const clock = { now: at(100) };
    const reader = readerFor(home.home, { now: () => clock.now });
    assert.equal((await reader.read()).sessions[0].seenThrough, at(100));
    await home.removeLogs();
    clock.now = at(200);
    assert.equal((await reader.read()).sessions[0].seenThrough, at(100), "frozen while the log is gone");
    await home.focus(at(150), localId(1));
    clock.now = at(300);
    assert.equal((await reader.read()).sessions[0].seenThrough, at(300), "now again once the log is back");
  });

  test("with every source but the desktop store missing, sessions come back with null live and null context, in recency order newest first", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1), lastTurnEdgeAt: at(1), cliSessionId: cliId(1) });
    assert.deepEqual(await readerFor(home.home).read(), {
      sessions: [{ id: localId(1), title: "A", recencyAt: at(1), createdAt: at(1), lastTurnEdgeAt: at(1), seenThrough: null, live: null, context: null }],
      order: { by: "recency", reversed: false },
      org: "org",
    });
  });

  test("the order is the active account's session list sort; another account's sort and other sections are ignored", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) }, { account: "old/org" });
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(2) }, { account: "new/org" });
    await home.touchAccount("old/org", at(100));
    await home.touchAccount("new/org", at(200));
    await home.preferences(sidebarPrefs({ "old/org": { sortBy: "created", ascending: false }, "new/org": { sortBy: "alpha", ascending: true } }));
    assert.deepEqual(await orderOf(readerFor(home.home)), { by: "alpha", reversed: true });
  });

  test("a missing preference file, account, or session list section, an unknown sortBy, or a file that is not JSON gives recency, newest first", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    const fallback = { by: "recency", reversed: false };
    assert.deepEqual(await orderOf(readerFor(home.home)), fallback, "no file");
    await home.preferences(sidebarPrefs({ "other/org": { sortBy: "alpha", ascending: true } }));
    assert.deepEqual(await orderOf(readerFor(home.home)), fallback, "no entry for the active account");
    await home.preferences(sidebarPrefs({ "account/org": null }));
    assert.deepEqual(await orderOf(readerFor(home.home)), fallback, "no session list section");
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "manual", ascending: true } }));
    assert.deepEqual(await orderOf(readerFor(home.home)), fallback, "unknown sortBy");
    await home.preferences('{"preferences": {"epitaxyPrefs": ');
    assert.deepEqual(await orderOf(readerFor(home.home)), fallback, "not JSON");
  });

  test("a changed preference file changes the order on the next read", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "created", ascending: false } }));
    const reader = readerFor(home.home);
    assert.deepEqual(await orderOf(reader), { by: "created", reversed: false });
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "recency", ascending: true } }));
    assert.deepEqual(await orderOf(reader), { by: "recency", reversed: true });
  });

  test("a preference file that stops being JSON keeps the last good order until it parses again", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "alpha", ascending: false } }));
    const reader = readerFor(home.home);
    assert.deepEqual(await orderOf(reader), { by: "alpha", reversed: false });
    await home.preferences('{"preferences": {"epitaxyPrefs": ');
    assert.deepEqual(await orderOf(reader), { by: "alpha", reversed: false });
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "created", ascending: true } }));
    assert.deepEqual(await orderOf(reader), { by: "created", reversed: true });
  });

  test("a preference file that cannot be read reports under sidebar with its code and path, keeps the last order, and the sessions still come back", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "alpha", ascending: true } }));
    const reports = [];
    const reader = readerFor(home.home, { report: (source, problem) => reports.push([source, problem]) });
    assert.deepEqual(await orderOf(reader), { by: "alpha", reversed: true });
    await home.loopPreferences();
    const facts = await reader.read();
    assert.deepEqual(facts.order, { by: "alpha", reversed: true });
    assert.deepEqual(facts.sessions.map(({ id }) => id), [localId(1)]);
    const sidebar = reports.filter(([source]) => source === "sidebar");
    assert.equal(sidebar.length, 1);
    assert.match(sidebar[0][1], /^ELOOP .*claude_desktop_config\.json$/);
  });

  test("two overlapping read() calls share one read", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    const reader = readerFor(home.home);
    const first = reader.read();
    assert.equal(reader.read(), first, "a call made while a read runs gets that read");
    await first;
    await home.session({ id: localId(2), title: "B", lastActivityAt: at(2) });
    assert.equal((await reader.read()).sessions.length, 2, "a call after it finished reads again");
  });

  test("a source failing the same way twice reports once, and its recovery once", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    const reports = [];
    const reader = readerFor(home.home, { report: (source, problem) => reports.push([source, problem]) });
    await reader.read();
    await reader.read();
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], "log");
    assert.match(reports[0][1], /^ENOENT .*main\.log$/);
    await home.focus(at(10), localId(1));
    await reader.read();
    await reader.read();
    assert.deepEqual(reports.slice(1), [["log", "recovered"]]);
  });

  test("org is the organization of the account folder with the newest mtime, and null with no account folder", async (t) => {
    const home = await fakeHome(t);
    assert.equal((await readerFor(home.home).read()).org, null);
    await home.session({ id: localId(1), title: "old account", lastActivityAt: at(9) }, { account: "acct-old/org-old" });
    await home.session({ id: localId(2), title: "new account", lastActivityAt: at(1) }, { account: "acct-new/org-new" });
    await home.touchAccount("acct-old/org-old", at(100));
    await home.touchAccount("acct-new/org-new", at(200));
    assert.equal((await readerFor(home.home).read()).org, "org-new");
    await home.touchAccount("acct-old/org-old", at(300));
    assert.equal((await readerFor(home.home).read()).org, "org-old");
  });
});

// --- usage reader: UsageReader against a fake home ---------------------------------------------

describe("usage reader", () => {
  const USAGE_QUERIES = ["", "?skip_spend=1", "?cedar_ember=1&skip_spend=1", "?at_wall=1&skip_spend=1"];
  const usageReaderFor = (home, reports = []) => new UsageReader({ platform: macOS(home), report: (source, problem) => reports.push([source, problem]) });
  const allPercent = async (reader, org = "org") => (await reader.read(org))?.limits.all.percent ?? null;

  test("each of the organization's four usage URLs is read, and another organization's is not", async (t) => {
    for (const [index, query] of USAGE_QUERIES.entries()) {
      const home = await fakeHome(t);
      await home.usage(usageUrl("org", query), { json: usageResponse({ all: 40 + index }) });
      await home.usage(usageUrl("other-org", query), { json: usageResponse({ all: 90 }) });
      assert.equal(await allPercent(usageReaderFor(home.home)), 40 + index, `usage${query}`);
    }
  });

  test("the response with the newest date wins, whatever the file mtimes", async (t) => {
    const home = await fakeHome(t);
    const dates = [100, 150, 300, 200];
    for (const [index, query] of USAGE_QUERIES.entries()) {
      await home.usage(usageUrl("org", query), { json: usageResponse({ all: 40 + index }), date: at(dates[index]), mtime: at(400 - 100 * index) });
    }
    const usage = await usageReaderFor(home.home).read("org");
    assert.equal(usage.limits.all.percent, 42);
    assert.equal(usage.fetchedAt, at(300));
  });

  test("a response without a date header was fetched when its file was written", async (t) => {
    const home = await fakeHome(t);
    await home.usage(usageUrl("org"), { mtime: at(42) });
    assert.equal((await usageReaderFor(home.home).read("org")).fetchedAt, at(42));
  });

  test("a file that holds another URL's response is not read, and is reported by file name only", async (t) => {
    const home = await fakeHome(t);
    await home.usage(usageUrl("org"), { holds: "https://api.anthropic.com/api/oauth/usage" });
    const reports = [];
    assert.equal(await usageReaderFor(home.home, reports).read("org"), null);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][0], "usage");
    assert.ok(reports[0][1].startsWith(`${cacheFileName(usageUrl("org"))} `), "the report names the file");
    assert.ok(!reports[0][1].includes("anthropic"), "the report holds nothing from the file");
  });

  test("a half-written file keeps the last good reading and is reported once; when it is finished it is read", async (t) => {
    const home = await fakeHome(t);
    const url = usageUrl("org");
    const reports = [];
    const reader = usageReaderFor(home.home, reports);
    await home.usage(url, { json: usageResponse({ all: 46 }), date: at(10) });
    assert.equal(await allPercent(reader), 46);
    await home.usage(url, { json: usageResponse({ all: 50 }), date: at(20), finished: false });
    assert.equal(await allPercent(reader), 46);
    assert.equal(await allPercent(reader), 46);
    assert.equal(reports.length, 1, "reported once");
    assert.ok(reports[0][1].startsWith(`${cacheFileName(url)} `), "the report names the file");
    await home.usage(url, { json: usageResponse({ all: 50 }), date: at(20) });
    assert.equal(await allPercent(reader), 50);
  });

  test("a body that is not JSON is reported without its contents", async (t) => {
    const home = await fakeHome(t);
    await home.usage(usageUrl("org"), { json: `{"limits": [SECRET-USAGE`, encoding: "identity" });
    const reports = [];
    assert.equal(await usageReaderFor(home.home, reports).read("org"), null);
    assert.equal(reports.length, 1);
    assert.ok(!reports[0][1].includes("SECRET"), reports[0][1]);
  });

  test("br, gzip, and identity bodies decode", async (t) => {
    for (const [index, encoding] of ["br", "gzip", "identity"].entries()) {
      const home = await fakeHome(t);
      await home.usage(usageUrl("org"), { json: usageResponse({ all: 60 + index }), encoding });
      assert.equal(await allPercent(usageReaderFor(home.home)), 60 + index, encoding);
    }
  });

  test("a zstd body decodes, with zlib where Node has zstd and with the zstd CLI where it does not", { skip: NO_ZSTD }, async (t) => {
    const home = await fakeHome(t);
    await home.usage(usageUrl("org", "?skip_spend=1"), { json: usageResponse({ all: 46, fable: 33 }), encoding: "zstd" });
    const reports = [];
    const usage = await usageReaderFor(home.home, reports).read("org");
    assert.deepEqual(reports, []);
    assert.deepEqual([usage.limits.all.percent, usage.limits.fable.percent], [46, 33]);
  });

  test("a file that is gone drops out; no file or no org gives null", async (t) => {
    const home = await fakeHome(t);
    const reader = usageReaderFor(home.home);
    assert.equal(await reader.read("org"), null, "no cache folder");
    await home.usage(usageUrl("org"), { json: usageResponse({ all: 40 }), date: at(10) });
    await home.usage(usageUrl("org", "?skip_spend=1"), { json: usageResponse({ all: 41 }), date: at(20) });
    assert.equal(await allPercent(reader), 41);
    await home.removeUsage(usageUrl("org", "?skip_spend=1"));
    assert.equal(await allPercent(reader), 40);
    await home.removeUsage(usageUrl("org"));
    assert.equal(await reader.read("org"), null);
    assert.equal(await reader.read(null), null);
  });
});

// --- windows: platform.js's win32 row against a fake home laid out as on Windows ---------------

describe("windows", () => {
  test("the readers find the session store, the sidebar preferences, main.log and main1.log, and the HTTP cache under AppData/Roaming/Claude", async (t) => {
    const home = await fakeHome(t, "win32");
    const platform = PLATFORMS.win32({ home: home.home, path: "" });
    await home.session({ id: localId(1), title: "A", lastActivityAt: at(1) });
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "alpha", ascending: false } }));
    await home.focus(at(10), localId(1));
    await home.rotateLog();
    await home.focus(at(30), null);
    await home.usage(usageUrl("org"), { json: usageResponse({ all: 46 }) });
    const facts = await readerFor(home.home, { platform }).read();
    assert.deepEqual(facts.sessions.map(({ id }) => id), [localId(1)], "the session store");
    assert.deepEqual(facts.order, { by: "alpha", reversed: false }, "the sidebar preferences");
    assert.equal(facts.sessions[0].seenThrough, at(30) + 999, "selected in main1.log, left in main.log");
    assert.equal((await new UsageReader({ platform }).read(facts.org))?.limits.all.percent, 46, "the HTTP cache");
  });

  test("the Windows row opens links with explorer.exe, looks for zstd.exe in each PATH folder, and has no deckkeys", () => {
    const windows = PLATFORMS.win32({ home: "/home", path: "/opt/zstd;;/usr/tools" });
    assert.equal(windows.opener, "explorer.exe");
    assert.deepEqual(windows.zstdClis, ["/opt/zstd/zstd.exe", "/usr/tools/zstd.exe"], "an empty PATH entry is skipped");
    assert.equal(windows.keySender, false);
  });
});

// --- plugin: app.js against a fake Studio server -----------------------------------------------

const { WebSocketServer } = createRequire(join(PLUGIN, "package.json"))("ws");

const FAKE_DECKKEYS = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(process.env.DECKKEYS_RECORD, line + "\\n");
  const sleeps = line.split(" ").filter((token) => token.startsWith("sleep:"));
  await sleep(sleeps.reduce((ms, token) => ms + Number(token.slice("sleep:".length)), 0));
  console.log("ok");
}
`;

const FAKE_OPEN = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.OPEN_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");
`;

/** An executable that runs `source` with this Node. A "#!<node>" line would break on Studio's Node, whose path has a space. */
function nodeExecutable(path, source) {
  writeFileSync(`${path}.mjs`, source);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "$0.mjs" "$@"\n`, { mode: 0o755 });
}

const keyOfSlot = (slot) => `${(slot - 1) % 5}_${Math.floor((slot - 1) / 5)}`;
const records = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean);

async function waitFor(check, what, deadlineMs = 5000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * The plugin as a child process against a fake Studio server, with HOME set to `home`.
 * @param {import("node:test").TestContext} t
 * @param {string} home
 * @param {{ deckkeys?: boolean }} [options]  deckkeys: false leaves bin/deckkeys out of the plugin's folder
 */
async function startDeck(t, home, { deckkeys = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-keys-"));
  cpSync(PLUGIN, dir, { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  if (deckkeys) nodeExecutable(join(dir, "bin", "deckkeys"), FAKE_DECKKEYS);
  nodeExecutable(join(dir, "open"), FAKE_OPEN);
  const keysRecord = join(dir, "keys.record");
  const openRecord = join(dir, "open.record");
  writeFileSync(keysRecord, "");
  writeFileSync(openRecord, "");

  const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(host, "listening");
  /** @type {Array<{ key: string, data: string, at: number }>} */
  const painted = [];
  let socket = null;
  let connections = 0;
  host.on("connection", (ws) => {
    socket = ws;
    connections++;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw);
      // The SDK echoes every message it receives back with code 0; only "state" is the plugin's own.
      if (message.cmd !== "state") return;
      for (const item of message.param?.statelist ?? []) painted.push({ key: item.key, data: item.data, at: Date.now() });
    });
  });

  const plugin = spawn(process.execPath, [join(dir, "app.js"), "127.0.0.1", String(host.address().port), "en"], {
    env: { ...process.env, HOME: home, CLAUDE_DECK_OPEN: join(dir, "open"), DECKKEYS_RECORD: keysRecord, OPEN_RECORD: openRecord },
    stdio: "ignore",
  });
  const exited = once(plugin, "exit");
  t.after(async () => {
    plugin.kill();
    await exited;
    host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([
    waitFor(() => connections === 1, "the plugin to connect"),
    exited.then(() => Promise.reject(new Error("plugin exited before connecting"))),
  ]);

  const send = (message) => socket.send(JSON.stringify(message));
  const instance = (key, actionid, uuid = SESSION_KEY) => ({ uuid, key, actionid: actionid ?? `action-${key}`, controller: "Keypad", device: "D200X" });
  const paints = (key) => painted.filter((item) => item.key === key);
  const images = (key) => paints(key).map((item) => item.data);

  return {
    add: (key, slot, { actionid } = {}) => send({ cmd: "add", ...instance(key, actionid), isInMultiAction: false, multiActionState: -1, param: { slot } }),
    setactive: (key, slot, active = true) => send({ cmd: "setactive", ...instance(key), active, param: { slot } }),
    clear: (key) => send({ cmd: "clear", param: [{ uuid: SESSION_KEY, key, actionid: `action-${key}` }] }),
    tap(key, slot, { events = ["keydown", "run", "keyup"], actionid } = {}) {
      for (const cmd of events) send({ cmd, ...instance(key, actionid), param: { slot } });
    },
    addUsage: (key, window) => send({ cmd: "add", ...instance(key, undefined, USAGE_KEY), isInMultiAction: false, multiActionState: -1, param: { window } }),
    tapUsage(key, window) {
      for (const cmd of ["keydown", "run", "keyup"]) send({ cmd, ...instance(key, undefined, USAGE_KEY), param: { window } });
    },
    turn: (uuid, rotateEvent) => send({ cmd: "dialrotate", uuid, key: "3_3", actionid: `${uuid}.1`, param: {}, rotateEvent }),
    async dropSocket() {
      const before = connections;
      socket.terminate();
      await waitFor(() => connections === before + 1, "the plugin to reconnect");
    },
    paints,
    images,
    latest: (key) => images(key).at(-1),
    async waitForImage(key, expected, deadlineMs) {
      await waitFor(() => images(key).at(-1) === expected, `key ${key} to show the expected image`, deadlineMs);
    },
    paintCount: () => painted.length,
    opened: () => records(openRecord).map((line) => JSON.parse(line)[0]),
    keys: () => records(keysRecord).flatMap((line) => line.split(" ").filter((token) => !token.startsWith("sleep:"))),
    log: () => readFileSync(join(dir, "dials.log"), "utf8"),
  };
}

const tile = (n, title, status = "idle", fill = { kind: "unknown" }) => ({ id: localId(n), title, status, fill });
const continueLink = (n) => `claude://code/continue?session=${localId(n)}`;

/** Idle sessions 1..count, newest first, so slot N shows session N. */
async function idleSessions(home, count = 5) {
  for (let n = 1; n <= count; n++) await home.session({ id: localId(n), title: `Session ${n}`, lastActivityAt: at(60 - n * 10) });
}

async function showKeys(deck, slots, expected) {
  for (const slot of slots) deck.add(keyOfSlot(slot), slot);
  for (const slot of slots) await deck.waitForImage(keyOfSlot(slot), firstFrame(expected[slot - 1]));
}

/** The usage keys sit on the top rows' last two cells, after the eight session keys. */
const USAGE_CELL = { all: "3_1", fable: "4_1" };
const textsIn = (image) => textsOf(svgOf(image)).map(({ content }) => content);
/** A reading fetched now that resets in a day, three and a half hours, so its key reads 1일 3시간 for the whole test. */
const freshUsage = (fields = {}) => ({
  json: usageResponse({ resetsAt: new Date(Date.now() + DAY_MS + 3.5 * HOUR_MS).toISOString(), ...fields }),
  encoding: PLUGIN_ENCODING,
  date: Date.now(),
});
const logLines = (deck, ending) => deck.log().split("\n").filter((line) => line.endsWith(ending));

describe("plugin", () => {
  test("of nine sessions, keys with slot 1..8 are painted with the eight most recent, newest first", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 9);
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "busy", statusUpdatedAt: at(70) });
    await home.catalog({ "claude-opus-5-5": 1_000_000 });
    await home.session({ id: localId(2), title: "Session 2", lastActivityAt: at(40), cliSessionId: cliId(2) });
    await home.transcript("/work/deck", cliId(2), [reply(370_000)]);
    const deck = await startDeck(t, home.home);
    const expected = [
      tile(1, "Session 1", "working"),
      tile(2, "Session 2", "idle", { kind: "percent", percent: 37 }),
      ...[3, 4, 5, 6, 7, 8].map((n) => tile(n, `Session ${n}`)),
    ];
    const all = [1, 2, 3, 4, 5, 6, 7, 8];
    await showKeys(deck, all, expected);
    for (const slot of all) assert.deepEqual(deck.images(keyOfSlot(slot)), [firstFrame(expected[slot - 1])], `slot ${slot} painted once`);
    assert.ok(!deck.log().includes("Session "), "no session title in dials.log");
  });

  test("keys on slots 6..8 open the session painted on them", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 8);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [6, 8], Array.from({ length: 8 }, (_, index) => tile(index + 1, `Session ${index + 1}`)));
    deck.tap(keyOfSlot(8), 8);
    await waitFor(() => deck.opened().length === 1, "slot 8 to open its session");
    deck.tap(keyOfSlot(6), 6);
    await waitFor(() => deck.opened().length === 2, "slot 6 to open its session");
    assert.deepEqual(deck.opened(), [continueLink(8), continueLink(6)]);
  });

  test("a key with slot 9 is never painted, opens nothing, and is logged, while the slot 8 key beside it works", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 9);
    const deck = await startDeck(t, home.home);
    deck.add("ninth", 9);
    await showKeys(deck, [8], Array.from({ length: 8 }, (_, index) => tile(index + 1, `Session ${index + 1}`)));
    deck.tap("ninth", 9);
    await sleep(POLL_MS * 1.5);
    assert.deepEqual(deck.images("ninth"), [], "slot 9 got no image");
    assert.deepEqual(deck.opened(), [], "slot 9 opened nothing");
    assert.ok(deck.log().includes(`session key without a slot 1..8: ${SESSION_KEY}___ninth___action-ninth 9`), "the bad slot is logged");
    deck.tap(keyOfSlot(8), 8);
    await waitFor(() => deck.opened().length === 1, "slot 8 to open its session");
    assert.deepEqual(deck.opened(), [continueLink(8)]);
  });

  test("a key on a slot with no session is painted blank", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "Only one", lastActivityAt: at(1) });
    const deck = await startDeck(t, home.home);
    deck.add(keyOfSlot(4), 4);
    await deck.waitForImage(keyOfSlot(4), firstFrame(null));
  });

  test("a status change on disk repaints only the key whose session changed", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 2, 3], [tile(1, "Session 1"), tile(2, "Session 2"), tile(3, "Session 3")]);
    await home.registry({ pid: process.pid, hostSessionId: localId(2), sessionId: cliId(2), status: "busy", statusUpdatedAt: at(80) });
    await deck.waitForImage(keyOfSlot(2), firstFrame(tile(2, "Session 2", "working")));
    await sleep(POLL_MS * 1.5);
    assert.equal(deck.images(keyOfSlot(1)).length, 1, "slot 1 not repainted");
    assert.equal(deck.images(keyOfSlot(2)).length, 2, "slot 2 painted once more");
    assert.equal(deck.images(keyOfSlot(3)).length, 1, "slot 3 not repainted");
  });

  test("a key whose session waits on a permission alternates its two frames every half second, while resting keys and dials.log stay still", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 3);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 2, 3], [tile(1, "Session 1"), tile(2, "Session 2"), tile(3, "Session 3")]);
    await home.registry({ pid: process.pid, hostSessionId: localId(2), sessionId: cliId(2), status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: at(80) });
    await waitFor(() => deck.images(keyOfSlot(2)).length >= 2, "slot 2 to show the wait");
    const log = deck.log();
    await waitFor(() => deck.images(keyOfSlot(2)).length >= 6, "slot 2 to show four more frames");
    const frames = renderFrames(tile(2, "Session 2", "permission"));
    const waiting = deck.paints(keyOfSlot(2)).slice(1, 6);
    const start = waiting[0].data === frames[0] ? 0 : 1;
    assert.deepEqual(waiting.map(({ data }) => data), waiting.map((_, index) => frames[(start + index) % 2]), "the two frames alternate");
    assert.ok(waiting.at(-1).at - waiting[0].at >= 4 * BLINK_MS - 300, "no faster than a frame per half second");
    assert.equal(deck.images(keyOfSlot(1)).length, 1, "slot 1 not repainted");
    assert.equal(deck.images(keyOfSlot(3)).length, 1, "slot 3 not repainted");
    assert.equal(deck.log(), log, "no log line per beat");
  });

  test("a flashing key opens its session when pressed", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 2);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 2], [tile(1, "Session 1"), tile(2, "Session 2")]);
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "waiting", waitingFor: "input needed", statusUpdatedAt: at(80) });
    await waitFor(() => deck.images(keyOfSlot(1)).length >= 3, "slot 1 to flash");
    assert.deepEqual(new Set(deck.images(keyOfSlot(1)).slice(1)), new Set(renderFrames(tile(1, "Session 1", "question"))), "slot 1 shows the question frames");
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.opened().length === 1, "the press to open the session");
    assert.deepEqual(deck.opened(), [continueLink(1)]);
  });

  test("when the wait ends, the key gets the working image once and nothing after", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 1);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1], [tile(1, "Session 1")]);
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: at(80) });
    await waitFor(() => deck.images(keyOfSlot(1)).length >= 3, "slot 1 to flash");
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "busy", statusUpdatedAt: at(90) });
    const working = firstFrame(tile(1, "Session 1", "working"));
    await deck.waitForImage(keyOfSlot(1), working);
    const count = deck.images(keyOfSlot(1)).length;
    await sleep(BLINK_MS * 4);
    assert.equal(deck.images(keyOfSlot(1)).length, count, "nothing after the working image");
    assert.equal(deck.images(keyOfSlot(1)).filter((image) => image === working).length, 1, "the working image once");
  });

  test("a repeated add or an active setactive repaints the key even when its image did not change", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    const image = firstFrame(tile(1, "Session 1"));
    await showKeys(deck, [1], [tile(1, "Session 1")]);
    deck.add(keyOfSlot(1), 1);
    await waitFor(() => deck.images(keyOfSlot(1)).length === 2, "a repaint after the repeated add");
    deck.setactive(keyOfSlot(1), 1);
    await waitFor(() => deck.images(keyOfSlot(1)).length === 3, "a repaint after setactive");
    deck.setactive(keyOfSlot(1), 1, false);
    await sleep(300);
    assert.deepEqual(deck.images(keyOfSlot(1)), [image, image, image], "setactive with active false paints nothing");
  });

  test("after the socket drops and the plugin reconnects, every known key is repainted without a new add", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    const expected = [tile(1, "Session 1"), tile(2, "Session 2")];
    await showKeys(deck, [1, 2], expected);
    await deck.dropSocket();
    for (const slot of [1, 2]) {
      await waitFor(() => deck.images(keyOfSlot(slot)).length === 2, `slot ${slot} repainted after reconnect`);
      assert.equal(deck.latest(keyOfSlot(slot)), firstFrame(expected[slot - 1]));
    }
  });

  test("a cleared key is no longer painted", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 2], [tile(1, "Session 1"), tile(2, "Session 2")]);
    deck.clear(keyOfSlot(2));
    await home.registry({ pid: process.pid, hostSessionId: localId(1), sessionId: cliId(1), status: "busy", statusUpdatedAt: at(80) });
    await home.registry({ pid: livePid(t), hostSessionId: localId(2), sessionId: cliId(2), status: "busy", statusUpdatedAt: at(80) });
    await deck.waitForImage(keyOfSlot(1), firstFrame(tile(1, "Session 1", "working")));
    await sleep(POLL_MS * 1.5);
    assert.equal(deck.images(keyOfSlot(2)).length, 1, "the cleared key got nothing after its first image");
  });

  test("keys follow the sidebar's sort; when two sessions trade places both keys are repainted, and slot 1 opens the session now on it", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    await home.preferences(sidebarPrefs({ "account/org": { sortBy: "recency", ascending: true } }));
    const deck = await startDeck(t, home.home);
    const oldestFirst = [5, 4, 3, 2, 1].map((n) => tile(n, `Session ${n}`));
    await showKeys(deck, [1, 2, 3, 4, 5], oldestFirst);
    await home.session({ id: localId(5), title: "Session 5", lastActivityAt: at(25) });
    await deck.waitForImage(keyOfSlot(1), firstFrame(tile(4, "Session 4")));
    await deck.waitForImage(keyOfSlot(2), firstFrame(tile(5, "Session 5")));
    for (const slot of [3, 4, 5]) assert.equal(deck.images(keyOfSlot(slot)).length, 1, `slot ${slot} not repainted`);
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.opened().length === 1, "slot 1 to open its session");
    assert.deepEqual(deck.opened(), [continueLink(4)]);
    assert.ok(!deck.log().includes(PREFERENCE_SECRET), "nothing from the preference file in dials.log");
  });

  test("a corrupt session file does not blank the other keys", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 2, 3], [tile(1, "Session 1"), tile(2, "Session 2"), tile(3, "Session 3")]);
    await home.corruptSession(localId(2));
    await sleep(POLL_MS * 1.5);
    assert.equal(deck.paintCount(), 3, "no key was repainted");
  });

  test("run on a slot opens claude://code/continue?session=<local id> of the session painted there, once", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 2], [tile(1, "Session 1"), tile(2, "Session 2")]);
    deck.tap(keyOfSlot(2), 2);
    await waitFor(() => deck.opened().length > 0, "the opener to run");
    await sleep(300);
    assert.deepEqual(deck.opened(), [continueLink(2)]);
  });

  test("keydown and keyup alone open nothing", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1], [tile(1, "Session 1")]);
    deck.tap(keyOfSlot(1), 1, { events: ["keydown", "keyup"] });
    await sleep(500);
    assert.deepEqual(deck.opened(), []);
    deck.tap(keyOfSlot(1), 1, { events: ["run"] });
    await waitFor(() => deck.opened().length === 1, "run to open the session");
    assert.deepEqual(deck.opened(), [continueLink(1)]);
  });

  test("run on an empty slot or an unknown key opens nothing", async (t) => {
    const home = await fakeHome(t);
    await home.session({ id: localId(1), title: "Session 1", lastActivityAt: at(1) });
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1, 3], [tile(1, "Session 1"), null, null]);
    deck.tap(keyOfSlot(3), 3);
    deck.tap(keyOfSlot(4), 1, { actionid: "never-added" });
    await sleep(500);
    assert.deepEqual(deck.opened(), [], "an empty slot and a key Studio never added open nothing");
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.opened().length === 1, "a filled slot to open");
    assert.deepEqual(deck.opened(), [continueLink(1)]);
  });

  test("run while the effort menu is open opens nothing, and the menu still commits", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home);
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1], [tile(1, "Session 1")]);
    deck.turn(EFFORT, "right");
    await sleep(50);
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.keys().includes("space"), "the effort menu to commit");
    assert.deepEqual(deck.keys(), ["cmd+shift+e", "down", "space"]);
    assert.deepEqual(deck.opened(), [], "the press under the open menu opened nothing");
    // The menu closes when deckkeys acknowledges the commit line, just after it is recorded.
    await sleep(200);
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.opened().length === 1, "a press after the commit to open");
  });

  test("usage keys show this week's all-models and Fable usage from the app's cache, and dials.log records each percent once", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 1);
    await home.usage(usageUrl("org", "?skip_spend=1"), freshUsage({ all: 46, fable: 33 }));
    const deck = await startDeck(t, home.home);
    deck.addUsage(USAGE_CELL.all, "all");
    deck.addUsage(USAGE_CELL.fable, "fable");
    await waitFor(() => deck.images(USAGE_CELL.all).length > 0 && deck.images(USAGE_CELL.fable).length > 0, "both usage keys to be painted");
    assert.deepEqual(textsIn(deck.latest(USAGE_CELL.all)), ["주간 전체", "초기화까지", "1일 3시간", "46%"]);
    assert.deepEqual(textsIn(deck.latest(USAGE_CELL.fable)), ["주간 Fable", "초기화까지", "1일 3시간", "33%"]);
    await sleep(POLL_MS * 1.5);
    assert.equal(deck.images(USAGE_CELL.all).length, 1, "not repainted while nothing changed");
    assert.equal(logLines(deck, "usage all: 46%").length, 1, "all logged once");
    assert.equal(logLines(deck, "usage fable: 33%").length, 1, "fable logged once");
  });

  test("a new reading in the app's cache repaints the usage key and is logged", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 1);
    await home.usage(usageUrl("org"), freshUsage({ all: 46 }));
    const deck = await startDeck(t, home.home);
    deck.addUsage(USAGE_CELL.all, "all");
    await waitFor(() => deck.images(USAGE_CELL.all).length > 0, "the usage key to be painted");
    assert.ok(textsIn(deck.latest(USAGE_CELL.all)).includes("46%"));
    await home.usage(usageUrl("org"), freshUsage({ all: 47 }));
    await waitFor(() => textsIn(deck.latest(USAGE_CELL.all)).includes("47%"), "the key to show the new reading");
    assert.equal(logLines(deck, "usage all: 47%").length, 1);
  });

  test("a usage key with an unknown window is never painted and is logged, while the usage key beside it is painted", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 1);
    await home.usage(usageUrl("org"), freshUsage());
    const deck = await startDeck(t, home.home);
    deck.addUsage("weekly", "weekly");
    deck.addUsage(USAGE_CELL.all, "all");
    await waitFor(() => deck.images(USAGE_CELL.all).length > 0, "the valid usage key to be painted");
    await sleep(POLL_MS * 1.5);
    assert.deepEqual(deck.images("weekly"), [], "the bad window got no image");
    assert.ok(deck.log().includes(`usage key without a window all|fable: ${USAGE_KEY}___weekly___action-weekly "weekly"`), "the bad window is logged");
  });

  test("pressing a usage key opens nothing, while a session key opens its session", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 1);
    await home.usage(usageUrl("org"), freshUsage());
    const deck = await startDeck(t, home.home);
    await showKeys(deck, [1], [tile(1, "Session 1")]);
    deck.addUsage(USAGE_CELL.all, "all");
    await waitFor(() => deck.images(USAGE_CELL.all).length > 0, "the usage key to be painted");
    deck.tapUsage(USAGE_CELL.all, "all");
    await sleep(500);
    assert.deepEqual(deck.opened(), [], "the usage key opened nothing");
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.opened().length === 1, "the session key to open its session");
    assert.deepEqual(deck.opened(), [continueLink(1)]);
  });

  test("without deckkeys the plugin stays up, logs that once, ignores the knobs, and draws and opens session keys as before", async (t) => {
    const home = await fakeHome(t);
    await idleSessions(home, 2);
    const deck = await startDeck(t, home.home, { deckkeys: false });
    await showKeys(deck, [1, 2], [tile(1, "Session 1"), tile(2, "Session 2")]);
    deck.turn(EFFORT, "right");
    deck.turn(SCROLL, "right");
    deck.tap(keyOfSlot(2), 2);
    await waitFor(() => deck.opened().length === 1, "slot 2 to open right after the knob turns, with no effort menu in the way");
    await sleep(RESTART_MS * 1.5);
    deck.tap(keyOfSlot(1), 1);
    await waitFor(() => deck.opened().length === 2, "slot 1 to open after a deckkeys restart would have come");
    assert.deepEqual(deck.opened(), [continueLink(2), continueLink(1)]);
    assert.equal(deck.log().split("\n").filter((line) => line.includes("deckkeys unavailable")).length, 1, "logged once, and never restarted");
  });

  test("a deck with only dials sends no state messages and reads no session files", async (t) => {
    const home = await fakeHome(t);
    const deck = await startDeck(t, home.home);
    deck.turn(SCROLL, "right");
    await waitFor(() => deck.keys().includes("pagedown"), "the scroll dial to work");
    await sleep(POLL_MS * 1.5);
    assert.equal(deck.paintCount(), 0, "no state messages");
    assert.ok(!deck.log().includes("sessions"), "no session source was read");
    deck.add(keyOfSlot(1), 1);
    await deck.waitForImage(keyOfSlot(1), firstFrame(null));
    await waitFor(() => deck.log().includes("sessions log ENOENT"), "the first session read to report the missing log");
  });
});
