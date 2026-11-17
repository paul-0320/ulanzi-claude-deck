// Pixels. Turns a session key's Tile into the SVG data URLs Studio rasterizes to 196x196, one
// frame for a key that holds still and two for a key that flashes, and a usage key's UsageTile
// into its one frame. This file owns every color, size, label, which statuses flash, how a
// duration reads, and every Qt SVG workaround, so nothing else learns them.
// Pure and deterministic: equal tiles give byte-equal strings, which is what keys.js diffs on.

/** @typedef {import("./board.js").Tile} Tile */
/** @typedef {import("./board.js").Status} Status */
/** @typedef {import("./board.js").Fill} Fill */
/** @typedef {import("./board.js").UsageTile} UsageTile */
/** @typedef {import("./usage.js").UsageWindow} UsageWindow */

const SIZE = 196;

// Qt drops the alpha of 8-digit hex colors, ignores font-weight on Korean glyphs, and breaks on
// dominant-baseline, filter, and clip-path. So colors are 6-digit, baselines are explicit y
// values, and the band color, not the weight, makes the label read as a label.
// `flash` is set for the statuses that wait on a person; its ink is the text color on the full
// band color, white on red but dark on orange, where white text is too faint.
/** @type {Readonly<Record<Status, { label: string, band: string, flash: { ink: string } | null }>>} */
const LOOK = Object.freeze({
  permission: { label: "권한", band: "#D92D20", flash: { ink: "#FFFFFF" } },
  question: { label: "질문", band: "#E8890C", flash: { ink: "#17191D" } },
  working: { label: "작업 중", band: "#1D6FD8", flash: null },
  review: { label: "확인", band: "#2E9E4F", flash: null },
  idle: { label: "쉼", band: "#3A3D44", flash: null },
});

// A usage key's band names its window. `ink` is the label color on that band: dark on yellow,
// where white is too faint.
/** @type {Readonly<Record<UsageWindow, { label: string, band: string, ink: string }>>} */
const USAGE_LOOK = Object.freeze({
  all: { label: "주간 전체", band: "#6E56CF", ink: "#FFFFFF" },
  fable: { label: "주간 Fable", band: "#FFC23D", ink: "#17191D" },
});

const COLOR = Object.freeze({ background: "#17191D", label: "#FFFFFF", ink: "#E6E8EB", track: "#2B2F36", amber: "#E3B341" });

const LAYOUT = Object.freeze({
  margin: 14,
  corner: 28,
  band: { height: 48, labelBaseline: 35, labelSize: 28 },
  flash: { labelBaseline: 51, labelSize: 46 },
  title: { size: 24, baselines: [78, 106] },
  fill: { textBaseline: 150, textSize: 44, barY: 162, barHeight: 16 },
  font: "Apple SD Gothic Neo, Helvetica, sans-serif",
});

const CONTENT_WIDTH = SIZE - 2 * LAYOUT.margin;
const TITLE_EMS_PER_LINE = CONTENT_WIDTH / LAYOUT.title.size;
const ELLIPSIS = "…";

/**
 * The frames one slot's key shows, in turn. A status with a flash has two: the ordinary face,
 * then the whole key in the band color with a large label. Every other tile, and the blank tile
 * of an empty slot (null), has one. Throws for a status with no look, so a status added to
 * board.js without a face fails its test.
 *
 * @param {Tile | null} tile
 * @returns {readonly string[]}  one or two "data:image/svg+xml;base64,..." strings
 */
export function renderFrames(tile) {
  if (!tile) return Object.freeze([dataUrl([keyRect(COLOR.background)])]);
  const look = LOOK[tile.status];
  if (!look) throw new Error(`no look for status ${tile.status}`);
  const face = dataUrl(faceParts(tile, look));
  return Object.freeze(look.flash ? [face, dataUrl(flashParts(tile, look, look.flash.ink))] : [face]);
}

/**
 * @param {Tile} tile
 * @param {typeof LOOK[Status]} look
 * @returns {string[]}  SVG elements
 */
function faceParts(tile, look) {
  return [...bandParts(look.band, look.label, COLOR.label), ...titleParts(tile.title, COLOR.ink), ...fillParts(tile.fill, null)];
}

/**
 * The dark key with the colored band and its label across the top.
 * @param {string} color  the band's
 * @param {string} label
 * @param {string} ink  the label's
 * @returns {string[]}  SVG elements
 */
function bandParts(color, label, ink) {
  const { band } = LAYOUT;
  return [
    keyRect(COLOR.background),
    // A rounded rect plus a square one over its lower half, so only the top corners are round.
    `<rect width="${SIZE}" height="${band.height}" rx="${LAYOUT.corner}" fill="${color}"/>`,
    `<rect y="${band.height / 2}" width="${SIZE}" height="${band.height / 2}" fill="${color}"/>`,
    text(label, { x: SIZE / 2, y: band.labelBaseline, size: band.labelSize, fill: ink, anchor: "middle" }),
  ];
}

/**
 * A usage key's one frame: the session face's band, two lines where its title goes, and the
 * percent and bar where its fill goes.
 * @param {UsageTile} tile
 * @returns {string}  a "data:image/svg+xml;base64,..." string
 */
export function renderUsage(tile) {
  const look = USAGE_LOOK[tile.window];
  const { lines, fill } = usageText(tile);
  const { margin, title } = LAYOUT;
  return dataUrl([
    ...bandParts(look.band, look.label, look.ink),
    ...lines.map(([content, ink], index) => text(content, { x: margin, y: title.baselines[index], size: title.size, fill: ink })),
    ...fillParts(fill, null),
  ]);
}

/**
 * @param {UsageTile} tile
 * @returns {{ lines: Array<[string, string]>, fill: Fill }}  each line's text and color
 */
function usageText(tile) {
  switch (tile.kind) {
    case "limit":
      return {
        lines: [
          tile.staleForMs === null ? ["초기화까지", COLOR.ink] : [`${ageText(tile.staleForMs)} 전 값`, COLOR.amber],
          [tile.resetsInMs === null ? "시각 모름" : durationText(tile.resetsInMs), COLOR.ink],
        ],
        fill: { kind: "percent", percent: tile.percent },
      };
    case "reset":
      return { lines: [["초기화됨", COLOR.ink], ["새 값 없음", COLOR.ink]], fill: { kind: "unknown" } };
    case "none":
      return { lines: [["값 없음", COLOR.ink]], fill: { kind: "unknown" } };
  }
}

const MINUTE_MS = 60_000;

/** @param {number} ms  floored to minutes: "1일 10시간", "2일", "3시간 20분", "3시간", "45분" */
function durationText(ms) {
  const minutes = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  if (days >= 1) return hours === 0 ? `${days}일` : `${days}일 ${hours}시간`;
  if (hours >= 1) return minutes % 60 === 0 ? `${hours}시간` : `${hours}시간 ${minutes % 60}분`;
  return `${minutes}분`;
}

/** @param {number} ms  "2시간", "45분" */
function ageText(ms) {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간` : `${minutes}분`;
}

/**
 * The title and fill stay where the face has them, so only the color and the label change
 * between the two frames.
 * @param {Tile} tile
 * @param {typeof LOOK[Status]} look
 * @param {string} ink
 * @returns {string[]}  SVG elements
 */
function flashParts(tile, look, ink) {
  const { flash } = LAYOUT;
  return [
    keyRect(look.band),
    text(look.label, { x: SIZE / 2, y: flash.labelBaseline, size: flash.labelSize, fill: ink, anchor: "middle" }),
    ...titleParts(tile.title, ink),
    ...fillParts(tile.fill, ink),
  ];
}

/** @param {string} fill */
function keyRect(fill) {
  return `<rect width="${SIZE}" height="${SIZE}" rx="${LAYOUT.corner}" fill="${fill}"/>`;
}

/** @param {string[]} parts  SVG elements */
function dataUrl(parts) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${parts.join("")}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * @param {string} title
 * @param {string} ink
 * @returns {string[]}  SVG elements
 */
function titleParts(title, ink) {
  const { margin, title: layout } = LAYOUT;
  return wrapTitle(title, TITLE_EMS_PER_LINE).map((line, index) => text(line, { x: margin, y: layout.baselines[index], size: layout.size, fill: ink }));
}

/**
 * @param {string} content
 * @param {{ x: number, y: number, size: number, fill: string, anchor?: "middle" | "end" }} options
 */
function text(content, { x, y, size, fill, anchor }) {
  const align = anchor ? ` text-anchor="${anchor}"` : "";
  return `<text x="${x}" y="${y}" font-family="${LAYOUT.font}" font-size="${size}" fill="${fill}"${align}>${escapeXml(content)}</text>`;
}

/** Code point ranges drawn full width: Hangul jamo, CJK and Hangul compatibility, syllables, fullwidth forms, emoji. */
const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xff00, 0xff60],
  [0x1f300, 0x1faff],
];

/**
 * Width of one character in ems. There is no font metrics API in a plain Node plugin, so this is
 * a table: wide characters are one em, Latin capitals and digits are wider than the rest.
 * @param {string} char  one code point
 */
function emsOf(char) {
  const code = char.codePointAt(0);
  if (char === ELLIPSIS || WIDE.some(([from, to]) => code >= from && code <= to)) return 1;
  if (char === " ") return 0.3;
  if (/[A-Z0-9]/.test(char)) return 0.65;
  return 0.55;
}

function emsOfAll(chars) {
  return chars.reduce((sum, char) => sum + emsOf(char), 0);
}

/**
 * How many leading chars fit in `ems`.
 * @param {string[]} chars
 * @param {number} ems
 */
function fitting(chars, ems) {
  let used = 0;
  for (let index = 0; index < chars.length; index++) {
    used += emsOf(chars[index]);
    if (used > ems) return index;
  }
  return chars.length;
}

/**
 * Two lines at most. Line one breaks at the last space that fits, or mid-word when there is
 * none (Korean titles often have none). Line two takes the rest and ends with "…" if it is cut.
 *
 * @param {string} title
 * @param {number} emsPerLine
 * @returns {[string] | [string, string]}
 */
function wrapTitle(title, emsPerLine) {
  // XML 1.0 forbids most control characters, and a newline would not break a line in SVG anyway.
  const chars = [...title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()];
  const fit = fitting(chars, emsPerLine);
  if (fit === chars.length) return [chars.join("")];
  const space = chars.lastIndexOf(" ", fit);
  const cut = space > 0 ? space : Math.max(fit, 1);
  const first = chars.slice(0, cut).join("").trimEnd();
  const rest = chars.slice(cut).join("").trim();
  const restChars = [...rest];
  if (emsOfAll(restChars) <= emsPerLine) return [first, rest];
  const kept = restChars.slice(0, fitting(restChars, emsPerLine - emsOf(ELLIPSIS)));
  return [first, kept.join("").trimEnd() + ELLIPSIS];
}

/**
 * The percent text and bar, the token count, or a dash. The bar keeps its level color on its
 * dark track in both frames; on the band color, the level colors would vanish as text.
 * @param {Fill} fill
 * @param {string | null} ink  the text color, or null for the face's: a percent in its level color
 * @returns {string[]}  SVG elements
 */
function fillParts(fill, ink) {
  const { margin } = LAYOUT;
  const { textBaseline, textSize, barY, barHeight } = LAYOUT.fill;
  const label = (content, color) =>
    text(content, { x: SIZE - margin, y: textBaseline, size: textSize, fill: ink ?? color, anchor: "end" });
  const rx = barHeight / 2;
  switch (fill.kind) {
    case "percent": {
      const color = levelColor(fill.percent);
      const width = Math.round((CONTENT_WIDTH * fill.percent) / 100);
      return [
        label(`${fill.percent}%`, color),
        `<rect x="${margin}" y="${barY}" width="${CONTENT_WIDTH}" height="${barHeight}" rx="${rx}" fill="${COLOR.track}"/>`,
        ...(width > 0 ? [`<rect x="${margin}" y="${barY}" width="${width}" height="${barHeight}" rx="${rx}" fill="${color}"/>`] : []),
      ];
    }
    case "tokens":
      return [label(tokensText(fill.tokens), COLOR.ink)];
    case "unknown":
      return [label("—", COLOR.ink)];
  }
}

function levelColor(percent) {
  if (percent < 60) return COLOR.ink;
  if (percent < 85) return COLOR.amber;
  return "#F85149";
}

/** @param {number} tokens  312000 → "312k", 1234567 → "1.2M" */
function tokensText(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}

/**
 * @param {string} content
 * @returns {string}  content with & < > " ' escaped for SVG text content and attributes
 */
function escapeXml(content) {
  return content.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}
