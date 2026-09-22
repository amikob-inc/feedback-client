import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { gzip, gzipSupported } from "../src/capture/gzip.js";
import { byteLength } from "../src/bytes.js";

describe("byteLength", () => {
  it("counts UTF-8 bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("💍")).toBe(4);
  });
});

describe("gzip", () => {
  it("produces a gzip blob that round-trips", async () => {
    const text = "<!doctype html><html><body>hello</body></html>";
    const blob = await gzip(text);
    expect(blob.type).toBe("application/gzip");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(bytes).toString("utf8")).toBe(text);
  });

  it("returns null when the browser has no CompressionStream", async () => {
    const original = globalThis.CompressionStream;
    delete globalThis.CompressionStream;
    try {
      expect(gzipSupported()).toBe(false);
      expect(await gzip("x")).toBe(null);
    } finally {
      globalThis.CompressionStream = original;
    }
  });

  it("warns once and returns null if the stream pipeline itself throws", async () => {
    const { resetWarnings } = await import("../src/warn.js");
    resetWarnings();
    const original = globalThis.CompressionStream;
    // gzipSupported() only checks that the constructor exists — it says nothing about whether
    // constructing or piping through it actually works. A CompressionStream that throws on
    // construction (a real-world case: some privacy-hardened browsers ship the constructor but
    // disable it) must degrade the same way an absent one does, not throw out of gzip().
    globalThis.CompressionStream = class {
      constructor() {
        throw new Error("disabled by policy");
      }
    };
    const warn = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warn.push(msg);
    try {
      expect(gzipSupported()).toBe(true);
      expect(await gzip("x")).toBe(null);
      expect(warn).toHaveLength(1);
      expect(warn[0]).toContain("gzip");
    } finally {
      globalThis.CompressionStream = original;
      console.warn = originalWarn;
    }
  });
});
