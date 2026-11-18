// Everything about the plugin that differs by OS, one row per OS Studio runs on. app.js picks the
// row once at startup and hands its values on; no other file asks which OS it runs on.

import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {object} Platform
 * @property {string} appData     the Claude app's data folder: its session store, preferences, and HTTP cache
 * @property {string} logs        the Claude app's log folder, which holds main.log and main1.log
 * @property {readonly string[]} opener  a command and its leading arguments; the URL to open goes last
 * @property {readonly string[]} zstdClis  zstd commands to try in order where Node's zlib has no zstd
 * @property {string | null} keySender  deckkeys' file name under bin/; null leaves the knobs sending nothing
 */

/**
 * Keyed by process.platform. Each row takes the user's home folder and the PATH variable.
 * @type {Readonly<Record<string, (env: { home: string, path: string }) => Platform>>}
 */
export const PLATFORMS = Object.freeze({
  darwin: ({ home }) => ({
    appData: join(home, "Library", "Application Support", "Claude"),
    logs: join(home, "Library", "Logs", "Claude"),
    opener: ["/usr/bin/open"],
    zstdClis: ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"],
    keySender: "deckkeys",
  }),
  // The Store (MSIX) build keeps its data in AppData\Local\Claude-Data\claude_<publisher id> and
  // writes main.log to AppData\Local\Claude\logs (seen on a Windows machine, 2026-11-18). Without
  // that folder, Electron's default folders under AppData\Roaming\Claude (read in the app's code,
  // not seen). zstd has no usual install folder on Windows.
  win32: ({ home, path }) => {
    const local = join(home, "AppData", "Local");
    const store = storeDataFolder(local);
    const roaming = join(home, "AppData", "Roaming", "Claude");
    return {
      appData: store ?? roaming,
      logs: store ? join(local, "Claude", "logs") : join(roaming, "logs"),
      // explorer.exe started from Node opens the Documents folder instead of a claude:// link.
      opener: ["rundll32.exe", "url.dll,FileProtocolHandler"],
      zstdClis: path.split(";").filter(Boolean).map((folder) => join(folder, "zstd.exe")),
      keySender: "deckkeys.exe",
    };
  },
});

/** @returns {string | null} the Store build's data folder, or null where that build is not installed */
function storeDataFolder(local) {
  const parent = join(local, "Claude-Data");
  let names;
  try {
    names = readdirSync(parent);
  } catch {
    return null;
  }
  const name = names.filter((entry) => entry.startsWith("claude_")).sort()[0];
  return name ? join(parent, name) : null;
}
