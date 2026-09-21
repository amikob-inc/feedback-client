import { describe, expect, it, vi } from "vitest";
import {
  CONSOLE_KEEP,
  CONSOLE_TEXT_MAX,
  describeArgs,
  describeError,
  describeValue,
  installConsoleBuffer,
} from "../src/buffers/console.js";
import { resetWarnings } from "../src/warn.js";

function fakeConsole() {
  const seen = [];
  const make =
    (level) =>
    (...args) =>
      seen.push([level, ...args]);
  return {
    seen,
    log: make("log"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    debug: make("debug"),
  };
}

const at = () => "2026-09-21T10:00:00.000Z";

describe("describeError", () => {
  it("is the name, the message and the first five stack frames on a real V8 stack", () => {
    const err = new Error("nope");
    err.name = "TypeError";
    err.stack = [
      "TypeError: nope",
      ...Array.from({ length: 8 }, (_, i) => `    at f${i} (a.js:${i})`),
    ].join("\n");
    const text = describeError(err);
    const lines = text.split("\n");
    expect(lines[0]).toBe("TypeError: nope");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("at f0 (a.js:0)");
    expect(lines[5]).toBe("at f4 (a.js:4)");
    expect(text).not.toContain("f5");
  });

  it("is the name, the message and the first five stack frames on a Firefox/Safari-shaped stack", () => {
    // No header line, no leading whitespace, no "at": frames read "fn@file:line:col".
    const err = new Error("nope");
    err.name = "TypeError";
    err.stack = Array.from({ length: 8 }, (_, i) => `f${i}@file.js:${i}:1`).join("\n");
    const text = describeError(err);
    const lines = text.split("\n");
    expect(lines[0]).toBe("TypeError: nope");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe("f0@file.js:0:1");
    expect(lines[5]).toBe("f4@file.js:4:1");
    expect(text).not.toContain("f5");
  });

  it("keeps every frame when there are fewer than five", () => {
    const err = new Error("nope");
    err.name = "TypeError";
    err.stack = ["TypeError: nope", "    at f0 (a.js:0)", "    at f1 (a.js:1)"].join("\n");
    expect(describeError(err)).toBe("TypeError: nope\nat f0 (a.js:0)\nat f1 (a.js:1)");
  });

  it("is just the head when there is no stack", () => {
    const err = new Error("plain");
    err.stack = undefined;
    expect(describeError(err)).toBe("Error: plain");
  });
});

describe("describeValue", () => {
  it("passes a string through", () => expect(describeValue("hi")).toBe("hi"));
  it("stringifies a number and null", () => {
    expect(describeValue(3)).toBe("3");
    expect(describeValue(null)).toBe("null");
  });
  it("serializes a plain object", () => expect(describeValue({ a: 1 })).toBe('{"a":1}'));
  it("falls back on a circular object", () => {
    const obj = {};
    obj.self = obj;
    expect(describeValue(obj)).toBe("[object Object]");
  });

  it("turns a logged Error into its name, message and first five stack lines, not '{}'", () => {
    const err = new Error("nope");
    err.name = "TypeError";
    err.stack = [
      "TypeError: nope",
      ...Array.from({ length: 8 }, (_, i) => `    at f${i} (a.js:${i})`),
    ].join("\n");
    const text = describeValue(err);
    expect(text).toBe(describeError(err));
    expect(text.split("\n")).toHaveLength(6);
    expect(text).not.toBe("{}");
  });

  it("guards a huge array instead of stringifying it", () => {
    const huge = new Array(2_000_000);
    const started = Date.now();
    const text = describeValue(huge);
    const elapsed = Date.now() - started;
    expect(text).toBe("[Array(2000000)]");
    expect(elapsed).toBeLessThan(50);
  });

  it("guards a huge string instead of returning it whole", () => {
    const huge = "x".repeat(5_000_000);
    const started = Date.now();
    const text = describeValue(huge);
    const elapsed = Date.now() - started;
    expect(text.length).toBeLessThanOrEqual(CONSOLE_TEXT_MAX);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("installConsoleBuffer", () => {
  it("records level, text and time, and still calls the original", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    target.error("boom", 3);
    expect(buffer.entries()).toEqual([
      { t: "2026-09-21T10:00:00.000Z", level: "error", text: "boom 3" },
    ]);
    expect(target.seen).toEqual([["error", "boom", 3]]);
    buffer.uninstall();
  });

  it("keeps the last 200 entries", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    for (let i = 0; i < CONSOLE_KEEP + 10; i += 1) target.log(`line ${i}`);
    const entries = buffer.entries();
    expect(entries).toHaveLength(CONSOLE_KEEP);
    expect(entries[0].text).toBe("line 10");
    expect(entries[CONSOLE_KEEP - 1].text).toBe(`line ${CONSOLE_KEEP + 9}`);
    buffer.uninstall();
  });

  it("cuts each entry at 1 KB", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    target.log("x".repeat(5000));
    expect(buffer.entries()[0].text).toHaveLength(CONSOLE_TEXT_MAX);
    buffer.uninstall();
  });

  it("restores the originals on uninstall", () => {
    const target = fakeConsole();
    const before = target.log;
    const buffer = installConsoleBuffer({ console: target, now: at });
    expect(target.log).not.toBe(before);
    buffer.uninstall();
    expect(target.log).toBe(before);
  });

  it("leaves a patch installed after this one alone on uninstall", () => {
    const target = fakeConsole();
    const buffer = installConsoleBuffer({ console: target, now: at });
    // Another library patches console.log after this one has already installed.
    const laterPatch = (...args) => target.seen.push(["log-later", ...args]);
    target.log = laterPatch;
    buffer.uninstall();
    expect(target.log).toBe(laterPatch);
  });

  it("is safe to call uninstall twice", () => {
    const target = fakeConsole();
    const before = target.log;
    const buffer = installConsoleBuffer({ console: target, now: at });
    buffer.uninstall();
    expect(() => buffer.uninstall()).not.toThrow();
    expect(target.log).toBe(before);
  });

  it("falls back to the original and warns once when recording throws", () => {
    resetWarnings();
    const target = fakeConsole();
    const warn = vi.fn();
    target.warn = warn;
    const buffer = installConsoleBuffer({
      console: target,
      now: () => {
        throw new Error("clock broke");
      },
    });
    expect(() => target.log("still printed")).not.toThrow();
    expect(() => target.log("still printed")).not.toThrow();
    expect(target.seen).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    buffer.uninstall();
  });

  it("warns once across an install, uninstall, install cycle — not once per install", () => {
    resetWarnings();
    const target = fakeConsole();
    const warn = vi.fn();
    target.warn = warn;
    const brokenNow = () => {
      throw new Error("clock broke");
    };

    const first = installConsoleBuffer({ console: target, now: brokenNow });
    target.log("a");
    first.uninstall();

    const second = installConsoleBuffer({ console: target, now: brokenNow });
    target.log("b");
    second.uninstall();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("describeArgs", () => {
  it("joins with a space", () => expect(describeArgs(["a", 1, true])).toBe("a 1 true"));
});
