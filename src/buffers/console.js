// The console buffer (spec §5.2): the last 200 entries, each cut at 1 KB, with the original
// console behaviour preserved. Errors keep their name, message and the first five stack frames —
// the triage run reads this instead of asking the reporter what the console said.
import { Ring, cut } from "./ring.js";
import { warnOnce } from "../warn.js";

export const CONSOLE_KEEP = 200;
export const CONSOLE_TEXT_MAX = 1024; // bytes: `cut` counts UTF-8 bytes, not JS string .length
export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"];
const STACK_FRAMES = 5;

// "The first five stack lines" has to mean that in any engine, not just V8. Chrome and Node
// prefix the stack with a repeat of "name: message" before the frames and indent each frame with
// "    at "; Firefox and Safari have none of that — no header line, no indentation, no "at"
// (frames read like "fn@file:line:col"). So: split on newlines, drop a leading line that only
// repeats the header we already have, drop blank lines, take the first five of what's left, and
// trim each. No engine-specific pattern anywhere in this.
export function describeError(err) {
  const name = err.name || "Error";
  const message = err.message || "";
  const head = `${name}: ${message}`;
  const stack = typeof err.stack === "string" ? err.stack : "";
  if (!stack) return head;
  const lines = stack.split("\n");
  const headerLine = lines[0] != null ? lines[0].trim() : "";
  const body = headerLine === head || headerLine === name ? lines.slice(1) : lines;
  const frames = body
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, STACK_FRAMES);
  return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

export function describeValue(value) {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "string") {
    // Cheap guard before anything else touches this string: `cut` trims the final joined text to
    // CONSOLE_TEXT_MAX bytes anyway, and a string already longer than that many UTF-16 units is
    // always at least that many UTF-8 bytes too (UTF-8 never uses fewer bytes than UTF-16 units
    // for the same text), so it is guaranteed to need cutting regardless of what it contains.
    return value.length > CONSOLE_TEXT_MAX ? value.slice(0, CONSOLE_TEXT_MAX) : value;
  }
  if (value === null || value === undefined || typeof value !== "object") return String(value);
  if (Array.isArray(value) && value.length > CONSOLE_TEXT_MAX) {
    // Same guard for arrays: every JSON array element costs at least one byte for itself plus a
    // separator, so an array with more elements than the whole per-entry byte budget can never
    // fit under that budget. Stringifying a multi-million-element array just to have `cut` throw
    // almost all of it away would stall the host app's own console.log for nothing.
    return `[Array(${value.length})]`;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function describeArgs(args) {
  return cut(args.map(describeValue).join(" "), CONSOLE_TEXT_MAX);
}

export function installConsoleBuffer({
  console: target = console,
  now = () => new Date().toISOString(),
} = {}) {
  const ring = new Ring(CONSOLE_KEEP);
  const originals = new Map();
  const patches = new Map();

  for (const level of CONSOLE_LEVELS) {
    const original = target[level];
    if (typeof original !== "function") continue;
    originals.set(level, original);
    const patched = function patchedConsole(...args) {
      try {
        ring.push({ t: now(), level, text: describeArgs(args) });
      } catch (err) {
        // The warning goes through the original console.warn, never through this patch.
        warnOnce("console buffer", err, originals.get("warn") || original);
      }
      return original.apply(this, args);
    };
    patches.set(level, patched);
    target[level] = patched;
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      // Restore only the levels this instance still owns. If something else patched
      // console[level] again after we did (another library initialized later, e.g. an
      // error-tracking SDK), console[level] is no longer our function — blindly restoring the
      // pre-install original would silently discard that later patch. That patch is the app's
      // business, not ours, so it stays exactly where it is.
      for (const [level, original] of originals) {
        if (target[level] === patches.get(level)) target[level] = original;
      }
      originals.clear();
      patches.clear();
    },
  };
}
