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
  it("is the name, the message and the first five stack frames", () => {
    const err = new Error("nope");
    err.name = "TypeError";
    err.stack = [
      "TypeError: nope",
      ...Array.from({ length: 8 }, (_, i) => `    at f${i} (a.js:${i})`),
    ].join("\n");
    const text = describeError(err);
    expect(text.split("\n")[0]).toBe("TypeError: nope");
    expect(text.split("\n")).toHaveLength(6);
    expect(text).toContain("    at f4 (a.js:4)");
    expect(text).not.toContain("    at f5 (a.js:5)");
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
});

describe("describeArgs", () => {
  it("joins with a space", () => expect(describeArgs(["a", 1, true])).toBe("a 1 true"));
});
