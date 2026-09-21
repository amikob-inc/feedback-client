import { describe, expect, it } from "vitest";
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
  it("cuts at the first ? when it cannot parse", () => {
    expect(scrubUrl("not a url?secret=1")).toBe("not a url");
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

function fakeXhr() {
  return class FakeXhr {
    constructor() {
      this.status = 0;
      this.handlers = [];
    }
    addEventListener(type, fn) {
      if (type === "loadend") this.handlers.push(fn);
    }
    open() {}
    send() {}
    finish(status) {
      this.status = status;
      for (const fn of this.handlers) fn();
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
});
