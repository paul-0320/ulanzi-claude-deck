import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");
const { WebSocketServer } = createRequire(join(PLUGIN, "package.json"))("ws");

const EFFORT = "com.ulanzi.ulanzistudio.claudeeffort.dial";
const SCROLL = "com.ulanzi.ulanzistudio.claudeeffort.scroll";
const SESSION = "com.ulanzi.ulanzistudio.claudeeffort.session";
const KNOB = { [SCROLL]: "2_3", [EFFORT]: "3_3", [SESSION]: "4_3" };
const CONFIRM_AFTER_IDLE_MS = 500;
const SETTLE_MS = CONFIRM_AFTER_IDLE_MS + 300;
const SETTLE_DEADLINE_MS = 5000;
const TIMER_SLACK_MS = 10;

const FAKE_DECKKEYS = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync(process.env.DECKKEYS_RECORD, JSON.stringify({ at: Date.now(), line }) + "\\n");
  const sleeps = line.split(" ").filter((token) => token.startsWith("sleep:"));
  await sleep(sleeps.reduce((ms, token) => ms + Number(token.slice("sleep:".length)), 0));
  console.log("ok");
}
`;

function readBatches(record) {
  return readFileSync(record, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      const { at, line } = JSON.parse(entry);
      const tokens = line.split(" ");
      const sleeps = tokens.filter((token) => token.startsWith("sleep:"));
      return {
        at,
        doneAt: at + sleeps.reduce((ms, token) => ms + Number(token.slice("sleep:".length)), 0),
        keys: tokens.filter((token) => !token.startsWith("sleep:")),
      };
    });
}

const keysOf = (batches) => batches.flatMap((batch) => batch.keys);
const idleBeforeCommit = (batches) => batches.at(-1).at - batches.at(-2).doneAt;

async function startDeck(t) {
  const dir = mkdtempSync(join(tmpdir(), "claude-dials-"));
  cpSync(PLUGIN, dir, { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "deckkeys.mjs"), FAKE_DECKKEYS);
  // Not a "#!<node>" line: Studio's Node lives under "Ulanzi Studio.app", and a shebang path cannot hold a space.
  writeFileSync(join(dir, "bin", "deckkeys"), `#!/bin/sh\nexec "${process.execPath}" "$0.mjs"\n`, { mode: 0o755 });
  const record = join(dir, "record.jsonl");
  writeFileSync(record, "");

  const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(host, "listening");
  const plugin = spawn(process.execPath, [join(dir, "app.js"), "127.0.0.1", String(host.address().port), "en"], {
    env: { ...process.env, DECKKEYS_RECORD: record },
    stdio: "ignore",
  });
  const exited = once(plugin, "exit");
  t.after(async () => {
    plugin.kill();
    await exited;
    host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const [socket] = await Promise.race([
    once(host, "connection"),
    exited.then(() => Promise.reject(new Error("plugin exited before connecting"))),
  ]);

  const send = (cmd, uuid, extra = {}) =>
    socket.send(JSON.stringify({ cmd, uuid, key: KNOB[uuid], actionid: `${uuid}.1`, param: {}, ...extra }));
  let seen = 0;

  return {
    async turn(uuid, rotateEvent, times, gapMs = 20) {
      for (let i = 0; i < times; i++) {
        if (i > 0) await sleep(gapMs);
        send("dialrotate", uuid, { rotateEvent });
      }
    },
    press(uuid) {
      send("dialdown", uuid);
      send("dialup", uuid);
    },
    async settle(t) {
      const deadline = Date.now() + SETTLE_DEADLINE_MS;
      for (;;) {
        const batches = readBatches(record);
        const quiet = batches.length > seen && Date.now() - batches.at(-1).doneAt >= SETTLE_MS;
        if (quiet || Date.now() >= deadline) {
          const fresh = batches.slice(seen);
          seen = batches.length;
          t.diagnostic(`recorded: ${fresh.map((batch) => batch.keys.join(" ")).join(" | ")}`);
          return fresh;
        }
        await sleep(25);
      }
    },
  };
}

test("effort dial opens its menu, moves the highlight, and confirms with space after the idle delay", async (t) => {
  const deck = await startDeck(t);
  await deck.turn(EFFORT, "right", 1);
  const batches = await deck.settle(t);
  assert.deepEqual(keysOf(batches), ["cmd+shift+e", "down", "space"], "one right turn opens the effort menu, moves one down, then selects");
  assert.ok(
    idleBeforeCommit(batches) >= CONFIRM_AFTER_IDLE_MS - TIMER_SLACK_MS,
    `space waits the idle delay after the last key send (waited ${idleBeforeCommit(batches)} ms)`,
  );
});

test("pressing the effort dial confirms without waiting for the idle delay", async (t) => {
  const deck = await startDeck(t);

  await deck.turn(EFFORT, "right", 1);
  await sleep(50);
  deck.press(EFFORT);
  let batches = await deck.settle(t);
  assert.deepEqual(keysOf(batches), ["cmd+shift+e", "down", "space"], "a press during the key send selects the highlighted effort");
  assert.ok(
    idleBeforeCommit(batches) < CONFIRM_AFTER_IDLE_MS,
    `a press during the key send confirms right after it (waited ${idleBeforeCommit(batches)} ms)`,
  );

  await deck.turn(EFFORT, "left", 1);
  await sleep(350);
  deck.press(EFFORT);
  batches = await deck.settle(t);
  assert.deepEqual(keysOf(batches), ["cmd+shift+e", "up", "space"], "a press after the key send selects the highlighted effort");
  assert.ok(
    idleBeforeCommit(batches) < CONFIRM_AFTER_IDLE_MS,
    `a press after the key send confirms at once (waited ${idleBeforeCommit(batches)} ms)`,
  );
});

test("session dial sends one session shortcut per detent and no menu or commit key", async (t) => {
  const deck = await startDeck(t);
  await deck.turn(SESSION, "right", 2);
  await deck.turn(SESSION, "left", 1);
  deck.press(SESSION);
  assert.deepEqual(
    keysOf(await deck.settle(t)),
    ["cmd+shift+]", "cmd+shift+]", "cmd+shift+["],
    "two right turns go to the next session twice, one left turn goes back, and the press sends nothing",
  );
});

test("scroll dial sends one page key per detent and nothing on press", async (t) => {
  const deck = await startDeck(t);
  await deck.turn(SCROLL, "right", 3);
  await deck.turn(SCROLL, "left", 2);
  deck.press(SCROLL);
  assert.deepEqual(
    keysOf(await deck.settle(t)),
    ["pagedown", "pagedown", "pagedown", "pageup", "pageup"],
    "three right turns page down three times, two left turns page up twice, and the press sends nothing",
  );
});

test("the session and scroll dials are ignored while the effort menu is open", async (t) => {
  const deck = await startDeck(t);
  await deck.turn(EFFORT, "right", 1);
  await sleep(50);
  await deck.turn(SESSION, "right", 2);
  await deck.turn(SCROLL, "right", 2);
  await deck.turn(SCROLL, "left", 1);
  deck.press(SESSION);
  deck.press(SCROLL);
  const batches = await deck.settle(t);
  assert.deepEqual(keysOf(batches), ["cmd+shift+e", "down", "space"], "session and scroll turns and presses send no keys into the effort menu");
  assert.ok(
    idleBeforeCommit(batches) >= CONFIRM_AFTER_IDLE_MS - TIMER_SLACK_MS,
    `session and scroll presses do not confirm the effort menu early (waited ${idleBeforeCommit(batches)} ms)`,
  );

  await deck.turn(SESSION, "right", 1);
  await deck.turn(SCROLL, "right", 1);
  assert.deepEqual(keysOf(await deck.settle(t)), ["cmd+shift+]", "pagedown"], "both step dials work again once the effort menu closes");
});
