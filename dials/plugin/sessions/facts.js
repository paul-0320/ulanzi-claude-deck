// What Claude's local files say about the most recent desktop sessions. This file owns every
// path under the app's folders and ~/.claude, every file format, and every join between the three ids
// a session has (desktop local id, CLI uuid, pid). It returns validated, joined SessionFacts and
// the order the app's sidebar lists them in. It decides nothing about what a key shows; board.js does.

import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { JsonFiles, findLastLine, readLinesFrom, statIfExists } from "./files.js";

/**
 * Desktop session id, "local_" + uuid. Only parseLocalId makes one, so it is safe in a URL query.
 * @typedef {string & { readonly __brand: "LocalSessionId" }} LocalSessionId
 */

/**
 * CLI session id, a uuid. Only parseCliId makes one, so it is safe as a file name
 * (it goes into a transcript path, and a crafted value must not climb out of ~/.claude/projects).
 * @typedef {string & { readonly __brand: "CliSessionId" }} CliSessionId
 */

/**
 * What the registry says about the live CLI process serving a desktop session.
 * `on` exists only while waiting, so a wait reason cannot outlive the wait.
 * @typedef {{ state: "busy" | "idle" | "shell" } | { state: "waiting", on: "permission" | "other" }} Live
 */

/**
 * @typedef {object} ContextUse
 * @property {number} usedTokens
 * @property {number | null} limitTokens  null when the model is not in the catalog
 */

/**
 * Everything the files say about one recent desktop session, joined and validated.
 * @typedef {object} SessionFacts
 * @property {LocalSessionId} id
 * @property {string} title               never empty: title, else the cwd's last folder, else "새 세션"
 * @property {number} recencyAt           epoch ms, the app's recency time: lastTurnEdgeAt, else lastActivityAt
 * @property {number} createdAt           epoch ms, the app's creation time: createdAt, else lastActivityAt; recencyAt when that is not positive or is after it
 * @property {number | null} lastTurnEdgeAt  epoch ms of the last turn start or end
 * @property {number | null} seenThrough  the user has seen the session up to this time; now while it is selected
 * @property {Live | null} live           null when no live CLI process serves the session
 * @property {ContextUse | null} context  null when there is no transcript or no usage line yet
 */

/**
 * How the app's sidebar sorts its session list. Each key has a natural direction
 * (recency and created: newest first; alpha: A to Z); `reversed` flips it.
 * @typedef {{ by: "recency" | "alpha" | "created", reversed: boolean }} ListOrder
 */

/**
 * One poll's result.
 * @typedef {object} Facts
 * @property {SessionFacts[]} sessions  in no particular order; board.js sorts them by `order`
 * @property {ListOrder} order          the active account's session list order
 * @property {string | null} org        the active folder's organization id; null without an active folder
 */

export class FactReader {
  #limit;
  #now;
  #report;
  /** @type {Map<string, string>} last problem per source, so one broken file logs once, not once a second */
  #problems = new Map();
  #desktop;
  #registry;
  #focus;
  #transcripts;
  #catalog;
  #sidebar;
  /** @type {DesktopRecent} the last result the desktop store gave, kept when listing it fails */
  #recent = { scope: null, sessions: [] };
  /** @type {ListOrder} the last order the sidebar preferences gave, kept when reading them fails */
  #order = DEFAULT_ORDER;
  /** @type {Promise<Facts> | null} */
  #inFlight = null;

  /**
   * @param {object} options
   * @param {string} options.home  the user's home folder; tests pass a temp folder
   * @param {Pick<import("../platform.js").Platform, "appData" | "logs">} options.platform  where the app keeps its files
   * @param {number} options.limit  how many recent sessions read() returns
   * @param {() => number} [options.now]
   * @param {(source: string, problem: string) => void} [options.report]  called when a source's problem changes
   */
  constructor({ home, platform, limit, now = Date.now, report = () => {} }) {
    const paths = pathsUnder(home, platform);
    this.#limit = limit;
    this.#now = now;
    this.#report = report;
    this.#desktop = new DesktopStore(paths.desktopRoot);
    this.#registry = new Registry(paths.registry);
    this.#focus = new FocusHistory(paths);
    this.#transcripts = new Transcripts(paths.projects);
    this.#catalog = new Catalog(paths.catalogDir);
    this.#sidebar = new SidebarPrefs(paths.preferences);
  }

  /**
   * The `limit` non-archived desktop sessions with the newest recency time, and the order the
   * app's sidebar lists them in. The sessions array has no order of its own.
   *
   * Never rejects. Each source fails alone: the desktop store, the sidebar preferences, the
   * catalog, and the log keep their last good values; the registry contributes nothing for a file
   * that is gone, because a stale "busy" or "waiting" would be worse than none. A call made while
   * another is running returns the running call's promise, so two pollers can never interleave
   * cache writes.
   *
   * @returns {Promise<Facts>}
   */
  read() {
    this.#inFlight ??= this.#readOnce().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** @returns {Promise<Facts>} */
  async #readOnce() {
    const now = this.#now();
    await this.#guard("catalog", () => this.#catalog.update());
    await this.#guard("log", () => this.#focus.update(now));
    this.#recent = (await this.#guard("desktop", () => this.#desktop.recent(this.#limit))) ?? this.#recent;
    this.#order = (await this.#guard("sidebar", () => this.#sidebar.orderOf(this.#recent.scope))) ?? this.#order;
    const live = (await this.#guard("registry", () => this.#registry.read())) ?? new Map();
    const shown = [];
    const sessions = await Promise.all(
      this.#recent.sessions.map(async (session) => {
        const entry = live.get(session.id);
        // The registry follows a CLI id change at once; the desktop file catches up seconds later.
        const cliId = entry?.cliSessionId ?? session.cliSessionId;
        if (cliId) shown.push(cliId);
        const use = cliId
          ? await this.#guard(`transcript ${cliId}`, () => this.#transcripts.contextOf(cliId, [entry?.cwd, session.cwd]))
          : null;
        return {
          id: session.id,
          title: session.title,
          recencyAt: session.recencyAt,
          createdAt: session.createdAt,
          lastTurnEdgeAt: session.lastTurnEdgeAt,
          seenThrough: latest(this.#focus.seenThrough(session.id), session.lastFocusedAt),
          live: entry?.live ?? null,
          context: use ? { usedTokens: use.usedTokens, limitTokens: this.#catalog.limitOf(use.model ?? session.model) } : null,
        };
      }),
    );
    this.#transcripts.retain(shown);
    return { sessions, order: this.#order, org: this.#recent.scope?.split("/")[1] ?? null };
  }

  /**
   * Runs one source step; on failure reports it (once per distinct problem) and returns undefined.
   * Problems carry an error code and a path only, never file content or a session title.
   * @template T
   * @param {string} source
   * @param {() => Promise<T>} step
   * @returns {Promise<T | undefined>}
   */
  async #guard(source, step) {
    try {
      const value = await step();
      if (this.#problems.delete(source)) this.#report(source, "recovered");
      return value;
    } catch (error) {
      const problem = [error.code ?? error.name, error.path].filter(Boolean).join(" ");
      if (this.#problems.get(source) !== problem) {
        this.#problems.set(source, problem);
        this.#report(source, problem);
      }
      return undefined;
    }
  }
}

function pathsUnder(home, { appData, logs }) {
  return {
    desktopRoot: join(appData, "claude-code-sessions"),
    registry: join(home, ".claude", "sessions"),
    projects: join(home, ".claude", "projects"),
    catalogDir: join(home, ".claude", "cache", "model-catalog"),
    preferences: join(appData, "claude_desktop_config.json"),
    log: join(logs, "main.log"),
    rotatedLog: join(logs, "main1.log"),
  };
}

function latest(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * @param {string} folder
 * @returns {Promise<string[]>} [] when the folder is missing
 */
async function listIfExists(folder) {
  try {
    return await readdir(folder);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? /** @type {number} */ (value) : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// Source 1: desktop session store

/**
 * @typedef {object} DesktopRecord
 * @property {LocalSessionId} id
 * @property {string} title
 * @property {CliSessionId | null} cliSessionId
 * @property {boolean} archived
 * @property {number} recencyAt
 * @property {number} createdAt
 * @property {number | null} lastTurnEdgeAt
 * @property {number | null} lastFocusedAt
 * @property {string | null} model
 * @property {string | null} cwd
 */

/**
 * @typedef {object} DesktopRecent
 * @property {string | null} scope  "<account>/<org>" of the active folder, the key the sidebar preferences use; null without one
 * @property {DesktopRecord[]} sessions
 */

const DESKTOP_FILE = /^local_.+\.json$/;

class DesktopStore {
  #root;
  /** @type {JsonFiles<DesktopRecord>} */
  #files = new JsonFiles(parseDesktopRecord);

  constructor(root) {
    this.#root = root;
  }

  /**
   * The active account and its `limit` non-archived sessions with the newest recency time, newest first.
   * @param {number} limit
   * @returns {Promise<DesktopRecent>}
   */
  async recent(limit) {
    const active = await this.#activeFolder();
    const names = active ? (await listIfExists(active.folder)).filter((name) => DESKTOP_FILE.test(name)) : [];
    const files = (
      await Promise.all(
        names.map(async (name) => {
          const path = join(active.folder, name);
          const stats = await statIfExists(path);
          return stats && { path, stats };
        }),
      )
    ).filter(Boolean);
    this.#files.retain(files.map(({ path }) => path));
    files.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

    /** @type {DesktopRecord[]} */
    const top = [];
    for (const { path, stats } of files) {
      // The recency time is never newer than its file's mtime (measured on 191 files: neither
      // lastTurnEdgeAt nor lastActivityAt was), so no file from here on can beat the last one kept.
      // Strictly less: a file whose mtime equals that one's recency time can still tie it and
      // win on id. After an app restart every mtime jumps and this reads all files once.
      if (top.length === limit && stats.mtimeMs < top[limit - 1].recencyAt) break;
      const record = await this.#files.get(path, stats);
      if (!record || record.archived) continue;
      top.push(record);
      top.sort(byRecency);
      top.length = Math.min(top.length, limit);
    }
    return { scope: active?.scope ?? null, sessions: top };
  }

  /**
   * The <account>/<org> folder with the newest mtime. Several accounts exist; the app writes to the signed-in one.
   * @returns {Promise<{ folder: string, scope: string, mtimeMs: number } | null>}
   */
  async #activeFolder() {
    let newest = null;
    for (const account of await listIfExists(this.#root)) {
      for (const org of await listIfExists(join(this.#root, account)).catch(() => [])) {
        const folder = join(this.#root, account, org);
        const stats = await statIfExists(folder);
        if (stats?.isDirectory() && (!newest || stats.mtimeMs > newest.mtimeMs)) {
          newest = { folder, scope: `${account}/${org}`, mtimeMs: stats.mtimeMs };
        }
      }
    }
    return newest;
  }
}

/**
 * Newest recency time first; ties by id ascending, so equal times never swap places between polls.
 * @param {DesktopRecord} a
 * @param {DesktopRecord} b
 */
function byRecency(a, b) {
  return b.recencyAt - a.recencyAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * @param {any} json
 * @returns {DesktopRecord | null}  null unless sessionId parses and lastActivityAt is a number
 */
function parseDesktopRecord(json) {
  const id = parseLocalId(json?.sessionId);
  const lastActivityAt = finiteOrNull(json?.lastActivityAt);
  if (!id || lastActivityAt === null) return null;
  const cwd = stringOrNull(json.cwd);
  const title = (typeof json.title === "string" ? json.title.trim() : "") || (cwd && basename(cwd)) || "새 세션";
  const lastTurnEdgeAt = finiteOrNull(json.lastTurnEdgeAt);
  // The app's row times (code-read): recency prefers the last turn edge over the last activity.
  // Creation is createdAt, else the last activity; a value that is not positive or is after the
  // recency time falls back to the recency time.
  const recencyAt = lastTurnEdgeAt ?? lastActivityAt;
  const createdAt = finiteOrNull(json.createdAt) ?? lastActivityAt;
  return {
    id,
    title,
    cliSessionId: parseCliId(json.cliSessionId),
    archived: json.isArchived === true,
    recencyAt,
    createdAt: createdAt > 0 && createdAt <= recencyAt ? createdAt : recencyAt,
    lastTurnEdgeAt,
    lastFocusedAt: finiteOrNull(json.lastFocusedAt),
    model: stringOrNull(json.model),
    cwd,
  };
}

// Source 2: CLI session registry

/**
 * @typedef {object} RegistryEntry
 * @property {LocalSessionId} host
 * @property {CliSessionId | null} cliSessionId
 * @property {Live | null} live  null for a status value this code does not know
 * @property {string | null} cwd
 * @property {number} updatedAt
 */

/** A registry file without hostSessionId: a spare CLI process the app keeps warm for the next session. */
const SPARE = Object.freeze({ spare: true });

// The only thing between this reader and the *.key files beside the registry entries.
const REGISTRY_FILE = /^(\d+)\.json$/;

class Registry {
  #folder;
  /** @type {JsonFiles<RegistryEntry | typeof SPARE>} */
  #files = new JsonFiles(parseRegistryEntry);

  constructor(folder) {
    this.#folder = folder;
  }

  /**
   * Live status per desktop session, from entries whose pid is alive.
   * @returns {Promise<Map<LocalSessionId, RegistryEntry>>}
   */
  async read() {
    /** @type {Map<LocalSessionId, RegistryEntry>} */
    const byHost = new Map();
    const listed = [];
    for (const name of await listIfExists(this.#folder)) {
      const match = REGISTRY_FILE.exec(name);
      if (!match) continue;
      const path = join(this.#folder, name);
      listed.push(path);
      if (!pidAlive(Number(match[1]))) continue;
      const stats = await statIfExists(path);
      const entry = stats && (await this.#files.get(path, stats));
      if (!entry || entry === SPARE) continue;
      const other = byHost.get(entry.host);
      if (!other || entry.updatedAt > other.updatedAt) byHost.set(entry.host, entry);
    }
    this.#files.retain(listed);
    return byHost;
  }
}

/**
 * @param {any} json
 * @returns {RegistryEntry | typeof SPARE | null}  null only for a shape this code cannot read
 */
function parseRegistryEntry(json) {
  if (typeof json !== "object" || json === null) return null;
  if (json.hostSessionId === undefined || json.hostSessionId === null || json.hostSessionId === "") return SPARE;
  const host = parseLocalId(json.hostSessionId);
  if (!host) return null;
  return {
    host,
    cliSessionId: parseCliId(json.sessionId),
    live: liveOf(json.status, json.waitingFor),
    cwd: stringOrNull(json.cwd),
    updatedAt: finiteOrNull(json.statusUpdatedAt) ?? finiteOrNull(json.updatedAt) ?? 0,
  };
}

/**
 * An unknown status becomes null, not a null entry: JsonFiles would keep the previous parse for
 * a null entry, and a stale "waiting" would keep a permission face up after the card is gone.
 * @param {unknown} status
 * @param {unknown} waitingFor
 * @returns {Live | null}
 */
function liveOf(status, waitingFor) {
  if (status === "busy" || status === "idle" || status === "shell") return { state: status };
  // Measured: "permission prompt" for a permission card, "input needed" for AskUserQuestion.
  if (status === "waiting") return { state: "waiting", on: waitingFor === "permission prompt" ? "permission" : "other" };
  return null;
}

function pidAlive(pid) {
  // kill(0, 0) would signal our own process group and say "alive".
  if (!(pid > 1)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Source 3: transcript tail

/**
 * Running result of folding transcript lines in file order.
 * @typedef {object} ContextFold
 * @property {number} usedTokens
 * @property {string | null} model  model of the last main-chain assistant line
 */

class Transcripts {
  #projects;
  /** @type {Map<CliSessionId, string>} found transcript path per CLI id */
  #paths = new Map();
  /** @type {Map<CliSessionId, { cursor: import("./files.js").Cursor, fold: ContextFold | null }>} */
  #follows = new Map();

  constructor(projects) {
    this.#projects = projects;
  }

  /**
   * Context use of one CLI session as of the transcript's last complete line.
   * @param {CliSessionId} cliId
   * @param {Array<string | null | undefined>} cwds  where to guess the project folder first
   * @returns {Promise<ContextFold | null>}
   */
  async contextOf(cliId, cwds) {
    const path = this.#paths.get(cliId) ?? (await this.#locate(cliId, cwds));
    if (!path) return null;
    const stats = await statIfExists(path);
    if (!stats) {
      this.#paths.delete(cliId);
      this.#follows.delete(cliId);
      return null;
    }
    let follow = this.#follows.get(cliId);
    if (!follow || follow.cursor.ino !== stats.ino || stats.size < follow.cursor.end) {
      // First sight, replaced, or truncated. The backward scan only picks where folding starts;
      // the forward fold is the one rule for what a line means, so a compact_boundary after the
      // last reply is handled the same way here and on every later append.
      const found = await findLastLine(path, isMainUsageLine);
      if (!found) return null;
      follow = { cursor: { ino: found.ino, end: found.offset }, fold: null };
    }
    if (stats.size > follow.cursor.end) {
      const read = await readLinesFrom(path, follow.cursor.end);
      if (read) follow = { cursor: read.cursor, fold: read.lines.reduce(foldContext, follow.fold) };
    }
    this.#follows.set(cliId, follow);
    return follow.fold;
  }

  async #locate(cliId, cwds) {
    const file = `${cliId}.jsonl`;
    const guesses = cwds.filter((cwd) => typeof cwd === "string" && cwd !== "").map((cwd) => slugOf(cwd));
    // The slug rule is code-read, not measured, so a miss falls back to every project folder.
    const folders = [...new Set([...guesses, ...(await listIfExists(this.#projects))])];
    for (const folder of folders) {
      const path = join(this.#projects, folder, file);
      if (await statIfExists(path)) {
        this.#paths.set(cliId, path);
        return path;
      }
    }
    return null;
  }

  /**
   * Drop follows and paths for CLI ids no longer shown, so memory stays at the shown sessions.
   * @param {Iterable<CliSessionId>} cliIds
   */
  retain(cliIds) {
    const keep = new Set(cliIds);
    for (const cliId of this.#paths.keys()) if (!keep.has(cliId)) this.#paths.delete(cliId);
    for (const cliId of this.#follows.keys()) if (!keep.has(cliId)) this.#follows.delete(cliId);
  }
}

/**
 * What one transcript line says about context use, or null for a line that says nothing.
 * @param {string} line
 * @returns {{ kind: "reply", usedTokens: number, model: string | null } | { kind: "compact", usedTokens: number } | null}
 */
function readContextLine(line) {
  if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) return null;
  let json;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (json?.type === "system" && json.subtype === "compact_boundary") {
    const post = finiteOrNull(json.compactMetadata?.postTokens);
    return post === null ? null : { kind: "compact", usedTokens: post };
  }
  if (json?.type !== "assistant" || json.isSidechain === true) return null;
  const { model, usage } = json.message ?? {};
  if (!usage || model === "<synthetic>") return null;
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].map(finiteOrNull);
  if (parts.every((part) => part === null)) return null;
  return { kind: "reply", usedTokens: parts.reduce((sum, part) => sum + (part ?? 0), 0), model: stringOrNull(model) };
}

function isMainUsageLine(line) {
  return readContextLine(line)?.kind === "reply";
}

/**
 * One rule for what a transcript line does to the running context use. One response spans
 * several lines that repeat the same usage; replacing, never adding, makes that harmless.
 * @param {ContextFold | null} fold
 * @param {string} line
 * @returns {ContextFold | null}
 */
function foldContext(fold, line) {
  const read = readContextLine(line);
  if (!read) return fold;
  if (read.kind === "compact") return { usedTokens: read.usedTokens, model: fold?.model ?? null };
  return { usedTokens: read.usedTokens, model: read.model };
}

/**
 * Project folder name Claude Code uses for a cwd. Code-read guess; #locate falls back to a search.
 * @param {string} cwd
 * @returns {string}
 */
function slugOf(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// Source 4: model catalog

const CATALOG_FILE = /-ccd\.json$/;

class Catalog {
  #folder;
  /** @type {JsonFiles<Map<string, number>>} */
  #files = new JsonFiles(parseCatalog);
  /** @type {Map<string, number>} */
  #limits = new Map();

  constructor(folder) {
    this.#folder = folder;
  }

  /** Reread the newest *-ccd.json when its stamp changes; keep the last good map otherwise. */
  async update() {
    let newest = null;
    for (const name of await listIfExists(this.#folder)) {
      if (!CATALOG_FILE.test(name)) continue;
      const path = join(this.#folder, name);
      const stats = await statIfExists(path);
      if (stats && (!newest || stats.mtimeMs > newest.stats.mtimeMs)) newest = { path, stats };
    }
    if (!newest) return;
    this.#files.retain([newest.path]);
    this.#limits = (await this.#files.get(newest.path, newest.stats)) ?? this.#limits;
  }

  limitOf(model) {
    return (model !== null && this.#limits.get(model)) || null;
  }
}

/**
 * @param {any} json
 * @returns {Map<string, number> | null}  catalog.config.models[].id → runtime.max_input_tokens
 */
function parseCatalog(json) {
  const models = json?.catalog?.config?.models;
  if (!Array.isArray(models)) return null;
  const limits = new Map();
  for (const model of models) {
    const limit = finiteOrNull(model?.runtime?.max_input_tokens);
    if (typeof model?.id === "string" && limit !== null && limit > 0) limits.set(model.id, limit);
  }
  return limits;
}

// Source 5: app log, which session is selected and until when

const FOCUS_LINE =
  /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[info\] \[CCD\] LocalSessions\.setFocusedSession: sessionId=(\S+)/;

class FocusHistory {
  #paths;
  /** @type {import("./files.js").Cursor} the file being followed and where folding stopped; ino -1 before any */
  #cursor = { ino: -1, end: 0 };
  /** @type {number | null} `now` of the last update that read the log to its end */
  #readAt = null;
  /** @type {LocalSessionId | null} */
  #selected = null;
  /** @type {Map<LocalSessionId, number>} end of the latest selection interval, or its start while it lasts */
  #seen = new Map();

  constructor(paths) {
    this.#paths = paths;
  }

  /**
   * Fold the lines appended since the last call. Throws when main.log cannot be read, and then
   * the selected session stays seen through the last successful read instead of through now.
   * @param {number} now
   */
  async update(now) {
    const stats = await statIfExists(this.#paths.log);
    if (!stats) throw Object.assign(new Error("log missing"), { code: "ENOENT", path: this.#paths.log });
    if (stats.ino !== this.#cursor.ino || stats.size < this.#cursor.end) {
      // A new main.log: at start, after a rotation, or after it reappeared. The bytes after the
      // cursor now sit in main1.log (renamed or copied), and at start that is all of main1.log.
      const rotated = await statIfExists(this.#paths.rotatedLog);
      if (rotated && rotated.size >= this.#cursor.end) await this.#fold(this.#paths.rotatedLog, this.#cursor.end);
      this.#cursor = { ino: stats.ino, end: 0 };
    }
    this.#cursor = (await this.#fold(this.#paths.log, this.#cursor.end)) ?? this.#cursor;
    this.#readAt = now;
  }

  async #fold(path, offset) {
    const read = await readLinesFrom(path, offset);
    if (!read) return null;
    for (const line of read.lines) {
      const event = line.includes("setFocusedSession") ? parseFocusLine(line) : null;
      if (event) this.#apply(event);
    }
    return read.cursor;
  }

  #apply({ at, id }) {
    if (this.#selected) this.#seen.set(this.#selected, at);
    // A lone null is a non-session screen: nothing is selected until the next id.
    this.#selected = id;
    if (id) this.#seen.set(id, at);
  }

  /**
   * @param {LocalSessionId} id
   * @returns {number | null}  through the last successful read while selected; the end of its latest interval otherwise
   */
  seenThrough(id) {
    const seen = this.#seen.get(id) ?? null;
    if (id !== this.#selected || this.#readAt === null) return seen;
    return latest(seen, this.#readAt);
  }
}

/**
 * @param {string} line
 * @returns {{ at: number, id: LocalSessionId | null } | null}
 */
function parseFocusLine(line) {
  const match = FOCUS_LINE.exec(line);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, value] = match;
  const id = value === "null" ? null : parseLocalId(value);
  if (value !== "null" && !id) return null;
  // Local time, whole seconds. `at` is the last millisecond of that second: a turn that ended
  // while the session was on screen, in the same second it was left, must not count as unseen.
  const at = new Date(+year, +month - 1, +day, +hour, +minute, +second).getTime() + 999;
  return { at, id };
}

// Source 6: app preferences, how the sidebar sorts the session list

/** The app's own default (code-read), and the answer whenever the file says nothing usable. @type {ListOrder} */
const DEFAULT_ORDER = Object.freeze({ by: "recency", reversed: false });

const SORT_KEYS = new Set(["recency", "alpha", "created"]);

class SidebarPrefs {
  #path;
  /** @type {JsonFiles<Map<string, ListOrder>>} */
  #files = new JsonFiles(parseSidebarOrders);

  constructor(path) {
    this.#path = path;
  }

  /**
   * The session list's order for one account. The file is parsed again only when its stamp
   * changes (the app rewrites it whenever any preference changes); while it does not parse, the
   * last good orders stay.
   * @param {string | null} scope  "<account>/<org>"; null gives the default
   * @returns {Promise<ListOrder>}
   */
  async orderOf(scope) {
    const stats = await statIfExists(this.#path);
    if (!stats) {
      this.#files.retain([]);
      return DEFAULT_ORDER;
    }
    const orders = await this.#files.get(this.#path, stats);
    return orders?.get(scope) ?? DEFAULT_ORDER;
  }
}

/**
 * The session list's order per account, and nothing else: the file also holds unrelated
 * settings (mcpServers among them) that must never reach a log line or an error.
 * @param {any} json
 * @returns {Map<string, ListOrder> | null}  null unless the file is a JSON object
 */
function parseSidebarOrders(json) {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const scopes = json.preferences?.epitaxyPrefs?.["dframe-code-sections"];
  /** @type {Map<string, ListOrder>} */
  const orders = new Map();
  if (typeof scopes !== "object" || scopes === null) return orders;
  for (const [scope, view] of Object.entries(scopes)) {
    const list = Array.isArray(view?.sections) ? view.sections.find((section) => section?.kind === "sessions") : null;
    if (list) orders.set(scope, SORT_KEYS.has(list.sortBy) ? Object.freeze({ by: list.sortBy, reversed: list.ascending === true }) : DEFAULT_ORDER);
  }
  return orders;
}

// Ids

const LOCAL_ID = /^local_[0-9a-f-]{36}$/i;
const CLI_ID = /^[0-9a-f-]{36}$/i;

/**
 * @param {unknown} value
 * @returns {LocalSessionId | null}
 */
function parseLocalId(value) {
  return typeof value === "string" && LOCAL_ID.test(value) ? /** @type {LocalSessionId} */ (value) : null;
}

/**
 * @param {unknown} value
 * @returns {CliSessionId | null}
 */
function parseCliId(value) {
  return typeof value === "string" && CLI_ID.test(value) ? /** @type {CliSessionId} */ (value) : null;
}
