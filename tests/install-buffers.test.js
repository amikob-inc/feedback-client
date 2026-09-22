/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { installBuffers } from "../src/buffers/install.js";

describe("installBuffers", () => {
  it("installs all four by default and takes them all down again", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const buffers = installBuffers({ win: window, doc: document, capture: {} });
    console.log("hello");
    document.getElementById("b").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    window.dispatchEvent(new window.Event("offline"));
    expect(buffers.console().some((e) => e.text === "hello")).toBe(true);
    expect(buffers.breadcrumbs()).toHaveLength(2);
    expect(buffers.errors()).toEqual([]);
    expect(buffers.network()).toEqual([]);
    buffers.uninstall();
    console.log("after");
    expect(buffers.console().some((e) => e.text === "after")).toBe(false);
  });

  it("leaves the console and network buffers out when the app switched them off", () => {
    const buffers = installBuffers({
      win: window,
      doc: document,
      capture: { console: false, network: false },
    });
    console.log("not recorded");
    expect(buffers.console()).toEqual([]);
    expect(buffers.network()).toEqual([]);
    buffers.uninstall();
  });

  it("passes capture.blank to the breadcrumbs", () => {
    // The recorder blocks on these selectors; the breadcrumb describer has to honour them too,
    // or a cost price reaches the report through the trail instead of the recording.
    document.body.innerHTML = `<div class="sku-price"><button id="a" data-cost="1240">Cost GBP 1,240</button></div>`;
    const buffers = installBuffers({
      win: window,
      doc: document,
      capture: { blank: [".sku-price"] },
    });
    document.getElementById("a").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffers.breadcrumbs()[0].target).toBe("button (hidden)");
    buffers.uninstall();
  });

  it("copes with a capture.blank that is not an array", () => {
    document.body.innerHTML = `<button id="a">Rings</button>`;
    const buffers = installBuffers({ win: window, doc: document, capture: { blank: ".x" } });
    document.getElementById("a").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffers.breadcrumbs()[0].target).toBe("button#a 'Rings'");
    buffers.uninstall();
  });

  it("passes maskAllInputs to the breadcrumbs", () => {
    document.body.innerHTML = `<input id="a" aria-label="Note">`;
    const buffers = installBuffers({
      win: window,
      doc: document,
      capture: { maskAllInputs: true },
    });
    const input = document.getElementById("a");
    input.value = "secret";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(buffers.breadcrumbs()[0].target).toBe("Note = •••");
    buffers.uninstall();
  });

  it("still uninstalls the other three buffers when one of them throws during uninstall", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const beforePush = window.history.pushState;
    const buffers = installBuffers({ win: window, doc: document, capture: {} });

    // Break only the error buffer's uninstall: it calls target.removeEventListener("error", ...)
    // with nothing guarding it (see src/buffers/errors.js), so a hostile/broken
    // removeEventListener is a real, if unusual, way for one buffer's teardown to fail.
    const originalRemove = window.removeEventListener.bind(window);
    window.removeEventListener = function throwingRemove(type, ...rest) {
      if (type === "error") throw new Error("boom");
      return originalRemove(type, ...rest);
    };
    try {
      expect(() => buffers.uninstall()).not.toThrow();
    } finally {
      window.removeEventListener = originalRemove;
    }

    // Console buffer detached despite the error buffer's uninstall throwing first.
    console.log("after uninstall");
    expect(buffers.console().some((e) => e.text === "after uninstall")).toBe(false);
    // Breadcrumb buffer detached too: its history patch is gone.
    expect(window.history.pushState).toBe(beforePush);
  });
});

describe("installBuffers when a buffer cannot install", () => {
  it("still returns a usable handle, and uninstalls only what attached", () => {
    // A window that is ordinary in every way except that reading `console` throws, which is what
    // the console buffer does first. The other three must still install, the handle must still
    // come back, and uninstall must still take off exactly what went on.
    const hostile = Object.create(window, {
      console: {
        get() {
          throw new Error("no console for you");
        },
      },
    });

    // The network buffer patches whatever window object it was handed, so the patch lands on
    // `hostile` as an own property and `window.fetch` itself never changes.
    const fetchBefore = hostile.fetch;
    let buffers;
    expect(() => {
      buffers = installBuffers({ win: hostile, doc: document, capture: {} });
    }).not.toThrow();

    expect(buffers.console()).toEqual([]);
    window.dispatchEvent(new window.Event("online"));
    expect(buffers.breadcrumbs().length).toBeGreaterThan(0);
    expect(hostile.fetch).not.toBe(fetchBefore);

    expect(() => buffers.uninstall()).not.toThrow();
    expect(hostile.fetch).toBe(fetchBefore);
    expect(() => buffers.uninstall()).not.toThrow();
  });
});
