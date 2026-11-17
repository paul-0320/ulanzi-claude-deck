// What the deck's keys show, as a pure function of the latest facts, plan usage, and time. This
// file owns every display policy: which session sits on which slot (the app sidebar's order),
// status priority, how context use becomes a fill, and when a usage reading counts as stale or
// past its reset. It does no I/O and keeps no state.

/** @typedef {import("./facts.js").SessionFacts} SessionFacts */
/** @typedef {import("./facts.js").ListOrder} ListOrder */
/** @typedef {import("./facts.js").LocalSessionId} LocalSessionId */
/** @typedef {import("./usage.js").PlanUsage} PlanUsage */
/** @typedef {import("./usage.js").UsageWindow} UsageWindow */

export const SLOT_COUNT = 8;

/** Highest priority first. A key shows exactly one. face.js must have a look for each. */
export const STATUSES = Object.freeze(/** @type {const} */ (["permission", "question", "working", "review", "idle"]));

/** @typedef {typeof STATUSES[number]} Status */

/** 1-based key slot, as the preset's ActionParam {"slot": N} names it. @typedef {1 | 2 | 3 | 4 | 5 | 6 | 7 | 8} Slot */

/**
 * How full the context window is, in the form the facts allow.
 * @typedef {{ kind: "percent", percent: number } | { kind: "tokens", tokens: number } | { kind: "unknown" }} Fill
 *   percent: 0..100, rounded, when the model's limit is known
 *   tokens: used tokens, when the model is missing from the catalog
 *   unknown: no transcript or no usage line yet
 */

/**
 * Everything one key face needs, and nothing else, so equal tiles render to equal images.
 * @typedef {object} Tile
 * @property {LocalSessionId} id
 * @property {string} title
 * @property {Status} status
 * @property {Fill} fill
 */

/**
 * Index i is slot i + 1. Always SLOT_COUNT long; null is an empty slot.
 * Invariant: the tiles are the sessions of one read, each once, in the sidebar's order from
 * slot 1, and every empty slot comes after the last tile.
 * @typedef {ReadonlyArray<Tile | null>} Board
 */

/** @type {Board} */
export const EMPTY_BOARD = Object.freeze(Array.from({ length: SLOT_COUNT }, () => null));

/**
 * @param {unknown} value  the preset's slot param, unvalidated
 * @returns {Slot | null}
 */
export function parseSlot(value) {
  return Number.isInteger(value) && value >= 1 && value <= SLOT_COUNT ? /** @type {Slot} */ (value) : null;
}

const TITLES = new Intl.Collator(undefined, { numeric: true });

/**
 * @param {string} a
 * @param {string} b
 */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The sidebar's sorts as the app compares rows (code-read), each in its natural direction.
 * `reversed` negates an entry; the id tie break stays outside the table, so equal rows keep one
 * order in both directions and never swap between polls.
 * @type {Readonly<Record<ListOrder["by"], (a: SessionFacts, b: SessionFacts) => number>>}
 */
const NATURAL_ORDER = Object.freeze({
  recency: (a, b) => b.recencyAt - a.recencyAt,
  created: (a, b) => b.createdAt - a.createdAt,
  alpha: (a, b) => TITLES.compare(a.title, b.title) || byCodeUnits(a.title, b.title),
});

/**
 * The board for one read: the sessions in the sidebar's order from slot 1, then empty slots.
 * @param {SessionFacts[]} sessions  at most SLOT_COUNT (FactReader's contract), in any order
 * @param {ListOrder} order
 * @returns {Board}
 */
export function boardOf(sessions, order) {
  const natural = NATURAL_ORDER[order.by];
  const sign = order.reversed ? -1 : 1;
  const sorted = [...sessions].sort((a, b) => sign * natural(a, b) || byCodeUnits(a.id, b.id));
  return Object.freeze(Array.from({ length: SLOT_COUNT }, (_, index) => (index < sorted.length ? tileOf(sorted[index]) : null)));
}

function tileOf(facts) {
  return Object.freeze({ id: facts.id, title: facts.title, status: statusOf(facts), fill: fillOf(facts.context) });
}

function statusOf({ live, lastTurnEdgeAt, seenThrough }) {
  if (live?.state === "waiting") return live.on === "permission" ? "permission" : "question";
  // busy also covers background shells and subagents after the turn ended, as the app's sidebar does.
  if (live?.state === "busy" || live?.state === "shell") return "working";
  // Not working means the last edge was a turn end, so "edge after seen" is "ended after last seen".
  if (lastTurnEdgeAt !== null && (seenThrough === null || lastTurnEdgeAt > seenThrough)) return "review";
  return "idle";
}

function fillOf(context) {
  if (context === null) return { kind: "unknown" };
  if (context.limitTokens === null) return { kind: "tokens", tokens: context.usedTokens };
  return { kind: "percent", percent: Math.min(100, Math.round((100 * context.usedTokens) / context.limitTokens)) };
}

/** A reading older than this shows its age instead of the words before the remaining time. */
export const STALE_MS = 30 * 60_000;

/**
 * Everything one usage key's face needs.
 * @typedef {{ window: UsageWindow, kind: "none" }
 *   | { window: UsageWindow, kind: "reset" }
 *   | { window: UsageWindow, kind: "limit", percent: number, resetsInMs: number | null, staleForMs: number | null }} UsageTile
 *   none: no reading, or the reading has no limit for this window
 *   reset: the window reset after the reading, so its percent is no longer true
 *   limit: resetsInMs is null when the reset time is unknown; staleForMs is set only past STALE_MS
 */

/**
 * @param {PlanUsage | null} usage
 * @param {UsageWindow} window
 * @param {number} now  epoch ms
 * @returns {UsageTile}
 */
export function usageTileOf(usage, window, now) {
  const limit = usage?.limits[window] ?? null;
  if (limit === null) return Object.freeze({ window, kind: "none" });
  if (limit.resetsAt !== null && now >= limit.resetsAt) return Object.freeze({ window, kind: "reset" });
  const age = now - usage.fetchedAt;
  return Object.freeze({
    window,
    kind: "limit",
    percent: limit.percent,
    resetsInMs: limit.resetsAt === null ? null : limit.resetsAt - now,
    staleForMs: age > STALE_MS ? age : null,
  });
}
