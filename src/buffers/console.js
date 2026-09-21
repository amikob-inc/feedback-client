// The console buffer (spec §5.2): the last 200 entries, each cut at 1 KB, with the original
// console behaviour preserved. Errors keep their name, message and the first five stack frames —
// the triage run reads this instead of asking the reporter what the console said.
import { Ring, cut } from "./ring.js";
import { warnOnce } from "../warn.js";

export const CONSOLE_KEEP = 200;
export const CONSOLE_TEXT_MAX = 1024;
export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"];
const STACK_FRAMES = 5;

export function describeError(err) {
  const head = `${err.name || "Error"}: ${err.message || ""}`;
  const stack = typeof err.stack === "string" ? err.stack.split("\n") : [];
  const frames = stack.filter((line) => /^\s+at\s/.test(line)).slice(0, STACK_FRAMES);
  return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

export function describeValue(value) {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "string") return value;
  if (value === null || value === undefined || typeof value !== "object") return String(value);
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

  for (const level of CONSOLE_LEVELS) {
    const original = target[level];
    if (typeof original !== "function") continue;
    originals.set(level, original);
    target[level] = function patched(...args) {
      try {
        ring.push({ t: now(), level, text: describeArgs(args) });
      } catch (err) {
        // The warning goes through the original console.warn, never through this patch.
        warnOnce("console buffer", err, originals.get("warn") || original);
      }
      return original.apply(this, args);
    };
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      for (const [level, original] of originals) target[level] = original;
      originals.clear();
    },
  };
}
