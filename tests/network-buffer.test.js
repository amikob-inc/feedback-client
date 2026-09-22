import { describe, expect, it, vi } from "vitest";
import {
  NETWORK_KEEP,
  SLOW_MS,
  installNetworkBuffer,
  scrubUrl,
  shouldRecord,
} from "../src/buffers/network.js";
import { createFakeWindow } from "./helpers/fake-window.js";

const at = () => "2026-09-21T10:00:00.000Z";

describe("scrubUrl", () => {
  it("keeps origin and path and drops the query string", () => {
    expect(scrubUrl("https://db.supabase.co/rest/v1/rings?select=*&id=eq.7")).toBe(
      "https://db.supabase.co/rest/v1/rings",
    );
  });
  it("drops the hash", () => {
    expect(scrubUrl("https://app.example/page#batch-3")).toBe("https://app.example/page");
  });
  it("resolves a relative URL against the page", () => {
    expect(scrubUrl("/api/x?token=abc", "https://app.example/rings")).toBe(
      "https://app.example/api/x",
    );
  });
  it("resolves a protocol-relative URL against the page", () => {
    expect(scrubUrl("//cdn.example.com/x?y=1", "https://app.example/rings")).toBe(
      "https://cdn.example.com/x",
    );
  });
  it("strips credentials from a URL with userinfo", () => {
    expect(scrubUrl("https://user:pass@host/path")).toBe("https://host/path");
  });
  it("drops an encoded # inside the query string along with the rest of the query", () => {
    // %23 is data inside the query, not a real fragment delimiter — must not survive either way.
    expect(scrubUrl("https://app.example/page?x=1%23y#frag")).toBe("https://app.example/page");
  });
  it("keeps only the scheme for a data: URL, never the payload", () => {
    // url.pathname for a data: URL is the entire base64/percent-encoded body; url.origin is the
    // literal string "null". Neither is safe to keep.
    expect(scrubUrl("data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==")).toBe("data:");
  });
  it("keeps the scheme and origin for a blob: URL, not the nested URL concatenated raw", () => {
    expect(scrubUrl("blob:https://app.example/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "blob:https://app.example",
    );
  });
  it("cuts at the first ? when it cannot parse and has no base", () => {
    // scrubUrl's own contract for a direct call with no base (`base` is optional on the exported
    // function). installNetworkBuffer always supplies a base when the target has a location, so
    // this exact path — no base at all — is exercised by a caller of scrubUrl directly, not by
    // the installed buffers; see "still strips a query via installNetworkBuffer when the target
    // has no location" below for the case where it *is* reached through install.
    expect(scrubUrl("not a url?secret=1")).toBe("not a url");
  });
  it("returns malformed text unchanged when there is no ? or # to cut at", () => {
    expect(scrubUrl(":::not-a-valid-url:::")).toBe(":::not-a-valid-url:::");
  });
});

describe("shouldRecord", () => {
  it("keeps a failure", () => expect(shouldRecord({ failed: true, status: 0, ms: 5 })).toBe(true));
  it("keeps a 400 and above", () => {
    expect(shouldRecord({ status: 400, ms: 5 })).toBe(true);
    expect(shouldRecord({ status: 399, ms: 5 })).toBe(false);
  });
  it("keeps anything slower than three seconds", () => {
    expect(shouldRecord({ status: 200, ms: SLOW_MS + 1 })).toBe(true);
    expect(shouldRecord({ status: 200, ms: SLOW_MS })).toBe(false);
  });
});

// A closer stand-in for a real XMLHttpRequest than the plan's version: it supports
// removeEventListener (the fix makes the "loadend" listener remove itself when it fires) and can
// be reopened and sent a second time without losing track of prior listeners, which is exactly
// what F3's reproduction below needs.
function fakeXhr() {
  return class FakeXhr {
    constructor() {
      this.status = 0;
      this.handlers = new Set();
    }
    addEventListener(type, fn) {
      if (type === "loadend") this.handlers.add(fn);
    }
    removeEventListener(type, fn) {
      if (type === "loadend") this.handlers.delete(fn);
    }
    open() {}
    send() {}
    finish(status) {
      this.status = status;
      for (const fn of [...this.handlers]) fn();
    }
  };
}

describe("installNetworkBuffer", () => {
  it("records a failed fetch and passes the response through", async () => {
    const win = createFakeWindow();
    let clock = 1000;
    win.fetch = async () => {
      clock += 120;
      return { status: 409 };
    };
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => clock });
    const res = await win.fetch("https://db.example/rest/v1/rings?id=eq.7", { method: "PATCH" });
    expect(res.status).toBe(409);
    expect(buffer.entries()).toEqual([
      { t: at(), method: "PATCH", url: "https://db.example/rest/v1/rings", status: 409, ms: 120 },
    ]);
    buffer.uninstall();
  });

  it("records a thrown fetch as status 0 and rethrows", async () => {
    const win = createFakeWindow();
    win.fetch = async () => {
      throw new Error("offline");
    };
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    await expect(win.fetch("/api/x")).rejects.toThrow("offline");
    expect(buffer.entries()[0]).toMatchObject({ status: 0, url: "https://app.example/api/x" });
    buffer.uninstall();
  });

  it("ignores a fast successful fetch", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 200 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    await win.fetch("/api/ok");
    expect(buffer.entries()).toEqual([]);
    buffer.uninstall();
  });

  it("keeps the last 50", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 500 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    for (let i = 0; i < NETWORK_KEEP + 3; i += 1) await win.fetch(`/api/${i}`);
    expect(buffer.entries()).toHaveLength(NETWORK_KEEP);
    expect(buffer.entries()[0].url).toBe("https://app.example/api/3");
    buffer.uninstall();
  });

  it("records an XMLHttpRequest that fails", () => {
    const win = createFakeWindow();
    win.XMLHttpRequest = fakeXhr();
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const xhr = new win.XMLHttpRequest();
    xhr.open("POST", "/api/save?token=secret");
    xhr.send();
    xhr.finish(503);
    expect(buffer.entries()).toEqual([
      { t: at(), method: "POST", url: "https://app.example/api/save", status: 503, ms: 0 },
    ]);
    buffer.uninstall();
  });

  it("restores fetch and the XHR prototype on uninstall", () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 200 });
    win.XMLHttpRequest = fakeXhr();
    const fetchBefore = win.fetch;
    const openBefore = win.XMLHttpRequest.prototype.open;
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    expect(win.fetch).not.toBe(fetchBefore);
    buffer.uninstall();
    expect(win.fetch).toBe(fetchBefore);
    expect(win.XMLHttpRequest.prototype.open).toBe(openBefore);
  });

  // F1: the fetch patch must not be able to break a request.
  it("still calls the original fetch and returns its result when computing the URL throws", async () => {
    const win = createFakeWindow();
    let originalFetchCalled = false;
    win.fetch = async (input) => {
      originalFetchCalled = true;
      return { status: 200, input };
    };
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const evilInput = {
      toString() {
        throw new Error("evil toString");
      },
    };
    const res = await win.fetch(evilInput);
    expect(originalFetchCalled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.input).toBe(evilInput);
    expect(buffer.entries()).toEqual([]);
    buffer.uninstall();
  });

  it("still calls the original XHR open and send when computing url metadata throws", () => {
    const win = createFakeWindow();
    win.XMLHttpRequest = fakeXhr();
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const xhr = new win.XMLHttpRequest();
    const evilUrl = {
      toString() {
        throw new Error("evil toString");
      },
    };
    expect(() => xhr.open("GET", evilUrl)).not.toThrow();
    expect(() => xhr.send()).not.toThrow();
    xhr.finish(500);
    expect(buffer.entries()).toEqual([]);
    buffer.uninstall();
  });

  // F2: uninstall must remove only its own layer.
  it("leaves a fetch patch installed after this one alone on uninstall", () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 200 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const laterPatch = async () => ({ status: 201 });
    win.fetch = laterPatch;
    buffer.uninstall();
    expect(win.fetch).toBe(laterPatch);
  });

  it("leaves an XHR patch installed after this one alone on uninstall", () => {
    const win = createFakeWindow();
    win.XMLHttpRequest = fakeXhr();
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const laterOpen = function laterOpen() {};
    const laterSend = function laterSend() {};
    win.XMLHttpRequest.prototype.open = laterOpen;
    win.XMLHttpRequest.prototype.send = laterSend;
    buffer.uninstall();
    expect(win.XMLHttpRequest.prototype.open).toBe(laterOpen);
    expect(win.XMLHttpRequest.prototype.send).toBe(laterSend);
  });

  it("is safe to call uninstall twice", () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 200 });
    win.XMLHttpRequest = fakeXhr();
    const fetchBefore = win.fetch;
    const openBefore = win.XMLHttpRequest.prototype.open;
    const sendBefore = win.XMLHttpRequest.prototype.send;
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    buffer.uninstall();
    expect(() => buffer.uninstall()).not.toThrow();
    expect(win.fetch).toBe(fetchBefore);
    expect(win.XMLHttpRequest.prototype.open).toBe(openBefore);
    expect(win.XMLHttpRequest.prototype.send).toBe(sendBefore);
  });

  // F3: the XHR listener must not leak across reuse. This is the reviewer's exact reproduction —
  // written first against the pre-fix code it failed with two entries, "/a" wrongly carrying the
  // second request's 500.
  it("does not mix one request's url into another's status when an XHR instance is reused", () => {
    const win = createFakeWindow();
    win.XMLHttpRequest = fakeXhr();
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    const xhr = new win.XMLHttpRequest();

    xhr.open("GET", "/a");
    xhr.send();
    xhr.finish(200); // succeeds: nothing should be recorded for this request

    xhr.open("GET", "/b");
    xhr.send();
    xhr.finish(500); // fails: exactly one entry, for /b, not for /a

    expect(buffer.entries()).toEqual([
      { t: at(), method: "GET", url: "https://app.example/b", status: 500, ms: 0 },
    ]);
    buffer.uninstall();
  });

  // F4: scrubUrl's data:/blob:/malformed handling, exercised through the real request paths too.
  it("scrubs a data: URL requested via fetch down to just the scheme", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 500 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    await win.fetch("data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==");
    expect(buffer.entries()).toEqual([
      { t: at(), method: "GET", url: "data:", status: 500, ms: 0 },
    ]);
    buffer.uninstall();
  });

  it("still strips a query string via installNetworkBuffer when the target has no location", async () => {
    // base is undefined whenever target.location is falsy — a real, if unusual, caller (a target
    // passed in explicitly without a location, e.g. a non-window object). This is the path
    // through which scrubUrl's no-base fallback branch is actually reached in practice, since
    // installNetworkBuffer's normal base (String(window.location)) makes almost anything parse.
    const win = createFakeWindow();
    win.location = undefined;
    win.fetch = async () => ({ status: 500 });
    const buffer = installNetworkBuffer({ target: win, now: at, clock: () => 0 });
    await win.fetch("/api/x?secret=1");
    expect(buffer.entries()).toEqual([
      { t: at(), method: "GET", url: "/api/x", status: 500, ms: 0 },
    ]);
    buffer.uninstall();
  });

  // F5: ms comes from performance.now(), not Date.now(), by default.
  it("uses performance.now() for ms by default", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 500 });
    const perfNow = vi.spyOn(performance, "now");
    perfNow.mockReturnValueOnce(1000).mockReturnValueOnce(1400);
    const dateNow = vi.spyOn(Date, "now");
    const buffer = installNetworkBuffer({ target: win, now: at });
    await win.fetch("/api/x");
    expect(buffer.entries()[0].ms).toBe(400);
    expect(dateNow).not.toHaveBeenCalled();
    buffer.uninstall();
  });

  it("falls back to Date.now() when performance is unavailable", async () => {
    const win = createFakeWindow();
    win.fetch = async () => ({ status: 500 });
    const originalPerformance = globalThis.performance;
    delete globalThis.performance;
    try {
      let dateClock = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => {
        dateClock += 300;
        return dateClock;
      });
      const buffer = installNetworkBuffer({ target: win, now: at });
      await win.fetch("/api/x");
      expect(buffer.entries()[0].ms).toBe(300);
      buffer.uninstall();
    } finally {
      globalThis.performance = originalPerformance;
    }
  });
});
