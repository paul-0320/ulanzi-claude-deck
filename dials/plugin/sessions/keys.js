// The thin shell for the deck's keys: it polls FactReader and UsageReader, builds the board and
// the usage tiles, renders each spot's frames, paints what changed, steps flashing keys on a
// half-second beat, and answers presses. State that outlives a poll: the key instances Studio
// told us about, the beat, the last board, and what each usage window last logged. None of it
// shapes the next poll; it is kept only to log what changed and to answer presses until the next
// poll replaces it.
// It knows nothing about the wire protocol; app.js parses each key's param into a Spot and
// translates messages into these four calls.

import { FactReader } from "./facts.js";
import { UsageReader, USAGE_WINDOWS } from "./usage.js";
import { EMPTY_BOARD, SLOT_COUNT, boardOf, usageTileOf } from "./board.js";
import { renderFrames, renderUsage } from "./face.js";

/** @typedef {import("./board.js").Board} Board */
/** @typedef {import("./board.js").Slot} Slot */
/** @typedef {import("./board.js").UsageTile} UsageTile */
/** @typedef {import("./usage.js").UsageWindow} UsageWindow */
/** @typedef {import("./facts.js").LocalSessionId} LocalSessionId */

const POLL_MS = 1000;
const BLINK_MS = 500;

/**
 * What a key shows: one session slot, or one usage window.
 * @typedef {{ kind: "session", slot: Slot } | { kind: "usage", window: UsageWindow }} Spot
 */

/** @param {Spot} spot */
function spotKey(spot) {
  return spot.kind === "session" ? `session:${spot.slot}` : `usage:${spot.window}`;
}

/**
 * A key instance Studio has on a page. `sent` is the image Studio last got from us for it, or
 * null when Studio may not have it (new instance, page re-entered, socket reconnected).
 * @typedef {{ spot: Spot, sent: string | null }} Instance
 */

export class DeckKeys {
  #reader;
  #usageReader;
  #paint;
  #open;
  #log;
  /** @type {Map<string, Instance>} keyed by Studio's context (uuid___key___actionid) */
  #instances = new Map();
  /** @type {Board | null} null until the first read finishes; then the last poll's board, for log diffs and presses */
  #board = null;
  /** @type {Map<string, readonly string[]>} the frames of every spot, by spotKey, as of the last poll */
  #frames = new Map();
  /** @type {Map<UsageWindow, string>} what each window last logged, so a line appears only when its kind or percent changes */
  #usageLogged = new Map();
  /** Each key shows frame #beat % its frame count, so one-frame keys never change with it. */
  #beat = 0;
  /** @type {ReturnType<typeof setTimeout> | null} the next beat; pending only while some spot has two frames */
  #beatTimer = null;
  #started = false;

  /**
   * @param {object} options
   * @param {string} options.home
   * @param {import("../platform.js").Platform} options.platform
   * @param {(context: string, image: string) => void} options.paint  sends one key image to Studio
   * @param {(url: string) => void} options.open  hands a claude:// link to the OS
   * @param {(...parts: string[]) => void} options.log
   */
  constructor({ home, platform, paint, open, log }) {
    const report = (source, problem) => log("sessions", source, problem);
    this.#reader = new FactReader({ home, platform, limit: SLOT_COUNT, report });
    this.#usageReader = new UsageReader({ platform, report });
    this.#paint = paint;
    this.#open = open;
    this.#log = log;
  }

  /**
   * A key instance is on the current page (Studio's add or setactive). Paints it as soon as
   * there is a poll, with the frame of the current beat, and from then on whenever that frame
   * changes. The first call starts polling, so a deck without these keys never reads Claude's
   * files.
   *
   * @param {string} context
   * @param {Spot} spot
   */
  show(context, spot) {
    this.#instances.set(context, { spot, sent: null });
    if (this.#board) this.#paintChanged();
    if (!this.#started) {
      this.#started = true;
      this.#loop();
    }
  }

  /**
   * The instance was deleted (Studio's clear), or Studio sent a param app.js could not parse.
   * @param {string} context
   */
  hide(context) {
    this.#instances.delete(context);
  }

  /**
   * Studio may have lost every image: the socket reconnected. Paint all instances again.
   * Paints sent while the socket was down were dropped by the SDK, which is why `sent` cannot be trusted.
   */
  repaint() {
    for (const instance of this.#instances.values()) instance.sent = null;
    if (this.#board) this.#paintChanged();
  }

  /**
   * Bring the session on this key's slot to the front. The slot comes from the instance Studio
   * added, not from the press message, whose payload was never captured on the device.
   * @param {string} context
   * @returns {LocalSessionId | null}  the session opened, or null for an unknown key, a usage key, or an empty slot
   */
  press(context) {
    const spot = this.#instances.get(context)?.spot;
    const tile = spot?.kind === "session" ? this.#board?.[spot.slot - 1] : null;
    if (!tile) {
      this.#log("session key press opened nothing:", context);
      return null;
    }
    this.#open(`claude://code/continue?session=${encodeURIComponent(tile.id)}`);
    this.#log("session key opened slot", String(spot.slot), tile.id);
    return tile.id;
  }

  async #loop() {
    try {
      await this.#tick();
    } catch (error) {
      this.#log("sessions tick failed:", error.message);
    }
    // Scheduled after the poll ends, so polls never overlap.
    setTimeout(() => this.#loop(), POLL_MS);
  }

  async #tick() {
    const facts = await this.#reader.read();
    const usage = await this.#usageReader.read(facts.org);
    const board = boardOf(facts.sessions, facts.order);
    const now = Date.now();
    const usageTiles = USAGE_WINDOWS.map((window) => usageTileOf(usage, window, now));
    this.#logChanges(this.#board ?? EMPTY_BOARD, board);
    this.#logUsage(usageTiles);
    this.#board = board;
    this.#frames = new Map([
      ...board.map((tile, index) => [spotKey({ kind: "session", slot: /** @type {Slot} */ (index + 1) }), renderFrames(tile)]),
      ...usageTiles.map((tile) => [spotKey({ kind: "usage", window: tile.window }), [renderUsage(tile)]]),
    ]);
    this.#paintChanged();
    this.#keepBeating();
  }

  /** Paint each instance whose spot's frame for this beat differs from what it was last sent. */
  #paintChanged() {
    for (const [context, instance] of this.#instances) {
      const frames = this.#frames.get(spotKey(instance.spot));
      const image = frames[this.#beat % frames.length];
      if (instance.sent === image) continue;
      this.#paint(context, image);
      instance.sent = image;
    }
  }

  /**
   * Schedules the next beat when some spot has two frames and no beat is pending. Each beat asks
   * again of the frames it finds, so the beat lapses by itself once no key flashes.
   */
  #keepBeating() {
    if (this.#beatTimer !== null || ![...this.#frames.values()].some((frames) => frames.length > 1)) return;
    this.#beatTimer = setTimeout(() => {
      this.#beatTimer = null;
      this.#beat++;
      this.#paintChanged();
      this.#keepBeating();
    }, BLINK_MS);
  }

  /**
   * One log line per slot whose session or status changed, so dials.log shows what the keys
   * showed. Ids and statuses only: a title never goes to the log.
   * @param {Board} before
   * @param {Board} after
   */
  #logChanges(before, after) {
    after.forEach((tile, index) => {
      const old = before[index];
      if (old?.id === tile?.id && old?.status === tile?.status) return;
      this.#log(`slot ${index + 1}:`, tile ? `${tile.id} ${tile.status}` : "empty");
    });
  }

  /**
   * One log line per window whose kind or percent changed. The remaining time and the age are
   * left out, so the log does not grow by a line a minute.
   * @param {UsageTile[]} tiles
   */
  #logUsage(tiles) {
    for (const tile of tiles) {
      const shown = tile.kind === "limit" ? `${tile.percent}%` : tile.kind;
      if (this.#usageLogged.get(tile.window) === shown) continue;
      this.#usageLogged.set(tile.window, shown);
      this.#log(`usage ${tile.window}:`, shown);
    }
  }
}
