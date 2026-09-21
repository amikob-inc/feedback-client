import { describe, expect, it } from "vitest";
import { ERRORS_KEEP, describeErrorEvent, installErrorBuffer } from "../src/buffers/errors.js";
import { createFakeWindow } from "./helpers/fake-window.js";

const at = () => "2026-09-21T10:00:00.000Z";

describe("describeErrorEvent", () => {
  it("reads an Error out of an error event", () => {
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n    at f (a.js:1)";
    expect(describeErrorEvent({ error: err, message: "ignored" })).toEqual({
      message: "kaboom",
      stack: "Error: kaboom\n    at f (a.js:1)",
    });
  });

  it("reads a rejection reason that is not an Error", () => {
    expect(describeErrorEvent({ reason: "just a string" })).toEqual({
      message: "just a string",
      stack: "",
    });
  });

  it("falls back to the event's message", () => {
    expect(describeErrorEvent({ message: "Script error." })).toEqual({
      message: "Script error.",
      stack: "",
    });
  });
});

describe("installErrorBuffer", () => {
  it("records window errors and unhandled rejections", () => {
    const win = createFakeWindow();
    const buffer = installErrorBuffer({ target: win, now: at });
    win.dispatch("error", { error: Object.assign(new Error("one"), { stack: "s1" }) });
    win.dispatch("unhandledrejection", { reason: new Error("two") });
    expect(buffer.entries()).toEqual([
      { t: at(), message: "one", stack: "s1" },
      { t: at(), message: "two", stack: buffer.entries()[1].stack },
    ]);
    buffer.uninstall();
  });

  it("keeps the last 20", () => {
    const win = createFakeWindow();
    const buffer = installErrorBuffer({ target: win, now: at });
    for (let i = 0; i < ERRORS_KEEP + 5; i += 1) win.dispatch("error", { message: `e${i}` });
    expect(buffer.entries()).toHaveLength(ERRORS_KEEP);
    expect(buffer.entries()[0].message).toBe("e5");
    buffer.uninstall();
  });

  it("removes its listeners on uninstall", () => {
    const win = createFakeWindow();
    const buffer = installErrorBuffer({ target: win, now: at });
    expect(win.countListeners()).toBe(2);
    buffer.uninstall();
    expect(win.countListeners()).toBe(0);
  });
});
