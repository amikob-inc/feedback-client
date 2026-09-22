/** @vitest-environment jsdom */
// jsdom, not the default node environment: `capture.blank` reaches the screenshot through a real
// selector match on a real cloned element, and a stand-in for `matches`/`removeAttribute` would
// only prove the stand-in works.
import { describe, expect, it, vi } from "vitest";
import {
  HOST_ID,
  SCREENSHOT_MAX,
  captureScreenshot,
  hideBlanked,
  maskClonedPassword,
} from "../src/capture/screenshot.js";
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

  it("passes capture.blank down as a clone hook, with the unusable selectors dropped", async () => {
    resetWarnings();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const domToBlob = vi.fn(async () => blobOf(10));
    await captureScreenshot({
      load: async () => ({ domToBlob }),
      target: document.body,
      blank: [".sku-price", "div:has-bad((("],
    });
    const { onCloneEachNode } = domToBlob.mock.calls[0][1];
    document.body.innerHTML =
      '<div class="sku-price">GBP 1,240</div><p>Rings</p><input type="password" value="hunter2">';
    const [priced, para, password] = [
      document.querySelector("div"),
      document.querySelector("p"),
      document.querySelector("input"),
    ];
    for (const el of [priced, para, password]) onCloneEachNode(el);
    expect(priced.textContent).toBe("");
    expect(para.textContent).toBe("Rings");
    // A password renders as dots, so the picture never showed it; the clone it is drawn from did.
    expect(password.getAttribute("value")).toBe("*******");
  });

  it("takes no hook action at all when the app named nothing", async () => {
    const domToBlob = vi.fn(async () => blobOf(10));
    await captureScreenshot({ load: async () => ({ domToBlob }), target: document.body });
    const { onCloneEachNode } = domToBlob.mock.calls[0][1];
    document.body.innerHTML = '<div class="sku-price">GBP 1,240</div>';
    onCloneEachNode(document.querySelector(".sku-price"));
    expect(document.querySelector(".sku-price").textContent).toBe("GBP 1,240");
  });
});

// The clone is emptied rather than excluded: excluding a node takes its box with it and the page
// reflows, and `visibility: hidden` is overridden by the `visibility: visible` modern-screenshot
// copies onto every descendant clone as inline style.
describe("maskClonedPassword", () => {
  it("masks a password's value and leaves its length", () => {
    document.body.innerHTML = '<input type="password" value="hunter2">';
    const el = document.querySelector("input");
    expect(maskClonedPassword(el)).toBe(true);
    expect(el.getAttribute("value")).toBe("*******");
  });

  it("leaves every other field alone", () => {
    document.body.innerHTML = '<input type="text" value="1240.00"><textarea>x</textarea>';
    expect(maskClonedPassword(document.querySelector("input"))).toBe(false);
    expect(maskClonedPassword(document.querySelector("textarea"))).toBe(false);
    expect(maskClonedPassword(document.createTextNode("x"))).toBe(false);
    expect(document.querySelector("input").getAttribute("value")).toBe("1240.00");
  });
});

describe("hideBlanked", () => {
  const clone = (html) => {
    document.body.innerHTML = html;
    return document.body.firstElementChild;
  };

  it("empties a blanked element and everything inside it", () => {
    const el = clone(
      '<div class="sku-price" style="width: 120px"><span>GBP 1,240</span>ada@example.com</div>',
    );
    expect(hideBlanked(el, ".sku-price")).toBe(true);
    expect(el.textContent).toBe("");
    expect(el.children.length).toBe(0);
    // The box survives: it is what keeps the picture a picture of the page.
    expect(el.getAttribute("style")).toBe("width: 120px");
  });

  it("takes away the attributes that paint without a child node", () => {
    const el = clone(
      '<input class="sku-price" value="1240.00" placeholder="cost" aria-label="cost" title="cost">',
    );
    hideBlanked(el, ".sku-price");
    expect(el.getAttribute("value")).toBe(null);
    expect(el.getAttribute("placeholder")).toBe(null);
    expect(el.getAttribute("aria-label")).toBe(null);
    expect(el.getAttribute("title")).toBe(null);
  });

  it("takes away the class the copied ::after rule would attach to", () => {
    const el = clone('<div class="sku-price _2b3c">x</div>');
    hideBlanked(el, ".sku-price");
    expect(el.getAttribute("class")).toBe(null);
  });

  it("leaves everything else exactly as it was", () => {
    const el = clone('<div class="row"><span>Rings</span></div>');
    expect(hideBlanked(el, ".sku-price")).toBe(false);
    expect(el.outerHTML).toBe('<div class="row"><span>Rings</span></div>');
  });

  it("ignores text nodes, no selector, and a selector the engine rejects", () => {
    const el = clone("<div>x</div>");
    expect(hideBlanked(document.createTextNode("x"), ".sku-price")).toBe(false);
    expect(hideBlanked(el, "")).toBe(false);
    expect(hideBlanked(el, "!!!")).toBe(false);
    expect(el.textContent).toBe("x");
  });
});
