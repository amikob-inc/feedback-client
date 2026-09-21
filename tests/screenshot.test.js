import { describe, expect, it, vi } from "vitest";
import { HOST_ID, SCREENSHOT_MAX, captureScreenshot } from "../src/capture/screenshot.js";
import { resetWarnings } from "../src/warn.js";

const blobOf = (size) => new Blob([new Uint8Array(size)], { type: "image/png" });

describe("captureScreenshot", () => {
  it("calls domToBlob with the spec's options and returns the blob", async () => {
    const domToBlob = vi.fn(async () => blobOf(10));
    const target = { tagName: "BODY" };
    const blob = await captureScreenshot({ load: async () => ({ domToBlob }), target });
    expect(blob.size).toBe(10);
    expect(domToBlob).toHaveBeenCalledTimes(1);
    const [node, options] = domToBlob.mock.calls[0];
    expect(node).toBe(target);
    expect(options.scale).toBe(1);
    expect(options.timeout).toBe(5000);
  });

  it("filters out the panel's own host element", async () => {
    const domToBlob = vi.fn(async () => blobOf(10));
    await captureScreenshot({ load: async () => ({ domToBlob }), target: {} });
    const { filter } = domToBlob.mock.calls[0][1];
    expect(filter({ nodeType: 1, id: HOST_ID })).toBe(false);
    expect(filter({ nodeType: 1, id: "app" })).toBe(true);
    expect(filter({ nodeType: 3 })).toBe(true);
  });

  // filter must key off the *configured* hostId, not a hardcoded string, so a caller who mounts
  // the panel under a different host element (or the demo harness, or a future second panel on
  // the same page) still gets its own frame excluded rather than HOST_ID's.
  it("filters by the given hostId, not always the default HOST_ID", async () => {
    const domToBlob = vi.fn(async () => blobOf(10));
    await captureScreenshot({
      load: async () => ({ domToBlob }),
      target: {},
      hostId: "other-host",
    });
    const { filter } = domToBlob.mock.calls[0][1];
    expect(filter({ nodeType: 1, id: "other-host" })).toBe(false);
    expect(filter({ nodeType: 1, id: HOST_ID })).toBe(true);
  });

  it("returns null and warns once when the module will not load", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blob = await captureScreenshot({
      load: async () => {
        throw new Error("no chunk");
      },
      target: {},
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null and warns once when domToBlob itself rejects", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blob = await captureScreenshot({
      load: async () => ({
        domToBlob: async () => {
          throw new Error("canvas tainted");
        },
      }),
      target: {},
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns null when domToBlob resolves with nothing", async () => {
    const blob = await captureScreenshot({
      load: async () => ({ domToBlob: async () => null }),
      target: {},
    });
    expect(blob).toBe(null);
  });

  it("returns null and warns once for a capture over 5 MB", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blob = await captureScreenshot({
      load: async () => ({ domToBlob: async () => blobOf(SCREENSHOT_MAX + 1) }),
      target: {},
    });
    expect(blob).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // The cap check is "> SCREENSHOT_MAX": a capture landing exactly on the cap must go through.
  it("keeps a capture exactly at the 5 MB cap", async () => {
    const blob = await captureScreenshot({
      load: async () => ({ domToBlob: async () => blobOf(SCREENSHOT_MAX) }),
      target: {},
    });
    expect(blob).not.toBe(null);
    expect(blob.size).toBe(SCREENSHOT_MAX);
  });

  it("SCREENSHOT_MAX is the spec's 5 MB", () => {
    expect(SCREENSHOT_MAX).toBe(5242880);
  });
});
