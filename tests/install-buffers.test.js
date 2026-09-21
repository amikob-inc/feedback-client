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
