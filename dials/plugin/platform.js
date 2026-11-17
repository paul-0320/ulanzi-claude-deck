// Everything about the plugin that differs by OS, one row per OS Studio runs on. app.js picks the
// row once at startup and hands its values on; no other file asks which OS it runs on.

import { join } from "node:path";

/**
 * @typedef {object} Platform
 * @property {string} appData     the Claude app's data folder: its session store, preferences, and HTTP cache
 * @property {string} logs        the Claude app's log folder, which holds main.log and main1.log
 * @property {string} opener      a command that opens the URL given as its only argument
 * @property {readonly string[]} zstdClis  zstd commands to try in order where Node's zlib has no zstd
 * @property {boolean} keySender  whether this OS has bin/deckkeys; without it the knobs send nothing
 */

/**
 * Keyed by process.platform. Each row takes the user's home folder and the PATH variable.
 * @type {Readonly<Record<string, (env: { home: string, path: string }) => Platform>>}
 */
export const PLATFORMS = Object.freeze({
  darwin: ({ home }) => ({
    appData: join(home, "Library", "Application Support", "Claude"),
    logs: join(home, "Library", "Logs", "Claude"),
    opener: "/usr/bin/open",
    zstdClis: ["/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"],
    keySender: true,
  }),
  // Electron's default userData and logs folders, which the app moves only on macOS (read in the
  // app's code, not yet seen on a Windows machine). zstd has no usual install folder there.
  win32: ({ home, path }) => ({
    appData: join(home, "AppData", "Roaming", "Claude"),
    logs: join(home, "AppData", "Roaming", "Claude", "logs"),
    opener: "explorer.exe",
    zstdClis: path.split(";").filter(Boolean).map((folder) => join(folder, "zstd.exe")),
    keySender: false,
  }),
});
