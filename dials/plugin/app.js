import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import UlanziApi from "./plugin-common-node/index.js";
import { PLATFORMS } from "./platform.js";
import { SLOT_COUNT, parseSlot } from "./sessions/board.js";
import { DeckKeys } from "./sessions/keys.js";
import { USAGE_WINDOWS, parseWindow } from "./sessions/usage.js";

const PLUGIN_UUID = "com.ulanzi.ulanzistudio.claudeeffort";
const HERE = dirname(fileURLToPath(import.meta.url));
const DECKKEYS = join(HERE, "bin", "deckkeys");
const LOG = join(HERE, "dials.log");

const MENU_OPEN_MS = 200;
const ARROW_GAP_MS = 15;
const CONFIRM_AFTER_IDLE_MS = 500;
const RESTART_MS = 1000;
const STEP_GAP_MS = 50;
// Right turns go down: toward 최대 in the effort menu, to the next session, and down the transcript.
const DELTA_FOR_ROTATION = { right: 1, "hold-right": 1, left: -1, "hold-left": -1 };

// connect() consumes argv, so keep the host's address and port for reconnects.
const [address = "127.0.0.1", port = "3906"] = process.argv.slice(2);

writeFileSync(LOG, "");
const log = (...parts) => appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(" ")}\n`);

const row = PLATFORMS[process.platform];
if (!row) {
  log("unsupported OS, exiting:", process.platform);
  process.exit(1);
}
const platform = row({ home: homedir(), path: process.env.PATH ?? "" });
// Tests point this at a recorder; a test that opened a real claude:// link would switch the developer's session.
const OPEN = process.env.CLAUDE_DECK_OPEN || platform.opener;

/**
 * deckkeys, kept running and fed one line at a time. Unavailable for good, with `child` null, when
 * this OS has no deckkeys or it fails to start: then send does nothing and the knobs are ignored,
 * while the session and usage keys, which send no keys, work on.
 */
class KeySender {
  /** @param {string | null} path  null where this OS has no deckkeys */
  constructor(path) {
    this.path = path;
    this.waiting = [];
    this.child = null;
    if (path === null) this.giveUp("none for this OS");
    else this.start();
  }

  get available() {
    return this.child !== null;
  }

  start() {
    try {
      this.child = spawn(this.path, ["--serve"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      // Some failures, ENOEXEC among them, throw here instead of emitting "error".
      return this.giveUp(error.code ?? error.message);
    }
    // A missing or unrunnable deckkeys emits "error" and never "exit", so it is not restarted.
    this.child.on("error", (error) => this.giveUp(error.code ?? error.message));
    this.child.stdin.on("error", (error) => log("deckkeys stdin:", error.message));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (line !== "ok") log("deckkeys:", line);
      this.waiting.shift()?.();
    });
    this.child.on("exit", (code) => {
      log("deckkeys exited:", code);
      this.waiting.splice(0).forEach((resolve) => resolve());
      setTimeout(() => this.start(), RESTART_MS);
    });
  }

  /** @param {string} reason */
  giveUp(reason) {
    this.child = null;
    log("deckkeys unavailable, the knobs send nothing:", reason);
    this.waiting.splice(0).forEach((resolve) => resolve());
  }

  send(tokens) {
    if (!this.available) return Promise.resolve();
    log("keys:", tokens.filter((token) => !token.startsWith("sleep:")).join(" "));
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.child.stdin.write(`${tokens.join(" ")}\n`);
    });
  }
}

const keys = new KeySender(platform.keySender ? DECKKEYS : null);

const EFFORT_DIAL = `${PLUGIN_UUID}.dial`;
const EFFORT_MENU_KEY = "cmd+shift+e";
// Space selects a menu item but only types a blank if the menu is somehow closed, where Return would send the draft.
const EFFORT_COMMIT_KEY = "space";

const stepDials = new Map([
  [`${PLUGIN_UUID}.session`, { [1]: "cmd+shift+]", [-1]: "cmd+shift+[" }],
  [`${PLUGIN_UUID}.scroll`, { [1]: "pagedown", [-1]: "pageup" }],
]);

// The app shows one menu at a time and the step dials share the effort dial's deckkeys, so there is one menu session and step dials wait it out.
const Phase = { IDLE: "idle", CHOOSING: "choosing", CONFIRMING: "confirming" };
let phase = Phase.IDLE;
let opening = [];
let pendingDelta = 0;
let sending = false;
let confirmRequested = false;
let confirmTimer = null;

function arrows(delta) {
  const key = delta > 0 ? "down" : "up";
  return Array.from({ length: Math.abs(delta) }, () => [key, `sleep:${ARROW_GAP_MS}`]).flat();
}

async function flush() {
  if (sending) return;
  sending = true;
  while (opening.length > 0 || pendingDelta !== 0) {
    const batch = [...opening, ...arrows(pendingDelta)];
    opening = [];
    pendingDelta = 0;
    await keys.send(batch);
  }
  sending = false;
  if (confirmRequested) confirm();
  else armConfirm();
}

function armConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(confirm, CONFIRM_AFTER_IDLE_MS);
}

async function confirm() {
  clearTimeout(confirmTimer);
  confirmRequested = false;
  if (phase !== Phase.CHOOSING) return;
  phase = Phase.CONFIRMING;
  await keys.send([EFFORT_COMMIT_KEY]);
  phase = Phase.IDLE;
}

function rotate({ uuid, rotateEvent }) {
  if (!keys.available) return;
  const delta = DELTA_FOR_ROTATION[rotateEvent];
  const shortcut = stepDials.get(uuid)?.[delta];
  if (shortcut) {
    // Under the open menu a session switch would land the commit key in another session, and a page key would not scroll.
    if (phase !== Phase.IDLE) return log("ignored dialrotate, the effort menu is open:", uuid);
    keys.send([shortcut, `sleep:${STEP_GAP_MS}`]);
    return;
  }
  if (uuid !== EFFORT_DIAL || delta === undefined) return log("unknown dialrotate:", uuid, rotateEvent);
  if (phase === Phase.CONFIRMING) return;
  if (phase === Phase.IDLE) {
    phase = Phase.CHOOSING;
    opening = [EFFORT_MENU_KEY, `sleep:${MENU_OPEN_MS}`];
  }
  clearTimeout(confirmTimer);
  pendingDelta += delta;
  flush();
}

function press({ uuid }) {
  if (uuid !== EFFORT_DIAL || phase === Phase.IDLE) return;
  if (sending) confirmRequested = true;
  else confirm();
}

const SESSION_KEY = `${PLUGIN_UUID}.sessionkey`;
const USAGE_KEY = `${PLUGIN_UUID}.usagekey`;

/**
 * Each key action's param, parsed into the Spot it shows. `field` names the param's one setting;
 * `invalid` starts the log line for a value that does not parse.
 * @type {Map<string, { field: string, spotOf: (value: unknown) => import("./sessions/keys.js").Spot | null, invalid: string }>}
 */
const KEY_ACTIONS = new Map([
  [
    SESSION_KEY,
    {
      field: "slot",
      spotOf: (value) => {
        const slot = parseSlot(value);
        return slot === null ? null : { kind: "session", slot };
      },
      invalid: `session key without a slot 1..${SLOT_COUNT}:`,
    },
  ],
  [
    USAGE_KEY,
    {
      field: "window",
      spotOf: (value) => {
        const window = parseWindow(value);
        return window === null ? null : { kind: "usage", window };
      },
      invalid: `usage key without a window ${USAGE_WINDOWS.join("|")}:`,
    },
  ],
]);

const deckKeys = new DeckKeys({
  home: homedir(),
  platform,
  paint: (context, image) => $UD.setBaseDataIcon(context, image),
  open: (url) => {
    const child = spawn(OPEN, [url], { stdio: "ignore", detached: true });
    child.on("error", (error) => log("open:", error.message));
    child.unref();
  },
  log,
});

function showKey({ uuid, context, param }) {
  const action = KEY_ACTIONS.get(uuid);
  if (!action) return;
  const value = param?.[action.field];
  const spot = action.spotOf(value);
  if (spot === null) {
    deckKeys.hide(context);
    log(action.invalid, context, JSON.stringify(value) ?? "undefined");
    return;
  }
  deckKeys.show(context, spot);
}

function pressSessionKey({ uuid, context }) {
  if (uuid !== SESSION_KEY) return;
  // Switching sessions under the open effort menu would land its commit key in the other session.
  if (phase !== Phase.IDLE) return log("ignored session key, the effort menu is open:", context);
  deckKeys.press(context);
}

const $UD = new UlanziApi();
$UD.on("connected", () => {
  log("connected", `${address}:${port}`);
  deckKeys.repaint();
});
$UD.on("dialrotate", rotate);
$UD.on("dialdown", press);
$UD.on("add", showKey);
$UD.on("setactive", (message) => {
  if (message.active === true) showKey(message);
});
$UD.on("clear", ({ param }) => {
  if (Array.isArray(param)) param.forEach(({ context }) => deckKeys.hide(context));
});
$UD.on("run", pressSessionKey);
$UD.on("error", (error) => log("error", error));
$UD.on("close", () => {
  log("closed, reconnecting");
  setTimeout(connect, RESTART_MS);
});

function connect() {
  $UD.connect(PLUGIN_UUID, port, address);
}
connect();
