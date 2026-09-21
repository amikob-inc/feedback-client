/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { BLANKED_ATTR, blankElements, snapshotDom, stampValues } from "../src/capture/dom.js";
import { resetWarnings } from "../src/warn.js";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  resetWarnings();
});

describe("snapshotDom", () => {
  it("stamps what the user typed as an attribute, so the clone shows it", () => {
    document.body.innerHTML = `<input id="a"><textarea id="b"></textarea>`;
    document.getElementById("a").value = "Solitaire";
    document.getElementById("b").value = "two lines\nhere";
    const html = snapshotDom(document, {});
    expect(html).toContain('value="Solitaire"');
    expect(html).toContain("two lines\nhere");
  });

  it("blanks a password whatever the settings", () => {
    document.body.innerHTML = `<input id="p" type="password">`;
    document.getElementById("p").value = "hunter2";
    expect(snapshotDom(document, {})).not.toContain("hunter2");
    expect(snapshotDom(document, {})).toContain('value=""');
  });

  it("blanks every typed value under maskAllInputs", () => {
    document.body.innerHTML = `<input id="a"><textarea id="b"></textarea>`;
    document.getElementById("a").value = "Dana";
    document.getElementById("b").value = "a note";
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).not.toContain("Dana");
    expect(html).not.toContain("a note");
  });

  it("stamps a checkbox and the selected option", () => {
    document.body.innerHTML = `
      <input id="c" type="checkbox">
      <select id="s"><option value="1">One</option><option value="2">Two</option></select>`;
    document.getElementById("c").checked = true;
    document.getElementById("s").selectedIndex = 1;
    const html = snapshotDom(document, {});
    expect(html).toContain("checked");
    expect(html).toMatch(/<option value="2" selected(=""|)>Two<\/option>/);
  });

  it("removes every script element", () => {
    document.body.innerHTML = `<script>window.x = 1;</script><p>kept</p>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("window.x = 1");
    expect(html).toContain("kept");
  });

  it("empties the blank selectors and marks them", () => {
    document.body.innerHTML = `<div class="sku-price">£4,200</div><div class="other">keep</div>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("4,200");
    expect(html).toContain(BLANKED_ATTR);
    expect(html).toContain("keep");
  });

  it("ignores a selector that is not valid CSS instead of throwing", () => {
    document.body.innerHTML = `<div class="x">keep</div>`;
    expect(() => snapshotDom(document, { blank: ["!!!"] })).not.toThrow();
  });

  it("starts with a doctype and does not touch the live page", () => {
    document.body.innerHTML = `<input id="a">`;
    document.getElementById("a").value = "live";
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html.startsWith("<!doctype html>\n<html")).toBe(true);
    expect(document.getElementById("a").value).toBe("live");
  });

  // --- Ugly inputs (task-5 standing rule 2) ---

  it("does not throw and still snapshots a document with no <head>", () => {
    // A separate Document, not the shared jsdom `document`: removing <head> is destructive and
    // jsdom does not grow it back, so mutating the global document here would break every test
    // that runs after this one in the same file.
    const doc = document.implementation.createHTMLDocument("");
    doc.head.remove();
    doc.body.innerHTML = `<input id="a" value="x">`;
    expect(() => snapshotDom(doc, {})).not.toThrow();
    const html = snapshotDom(doc, {});
    expect(html).toContain('value="x"');
  });

  it("never leaks a password sitting inside an open shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<input type="password" id="sp">`;
    root.getElementById("sp").value = "hunter2";
    const html = snapshotDom(document, {});
    // outerHTML/cloneNode never serialize shadow-root content, open or closed, so the field is
    // simply absent from the snapshot rather than present-but-masked — either way "hunter2" must
    // never appear.
    expect(html).not.toContain("hunter2");
  });

  it("never reaches into a same-origin iframe's content document", () => {
    let touched = false;
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    // A getter that flips a flag if it is ever read stands in for both the same-origin case
    // (reading it would be legal but is still not our business) and the cross-origin case
    // (reading it would throw a SecurityError) — snapshotDom must never read this property at
    // all, so the flag must stay false and no throw must escape either way.
    Object.defineProperty(iframe, "contentDocument", {
      get() {
        touched = true;
        throw new Error("cross-origin access");
      },
    });
    expect(() => snapshotDom(document, {})).not.toThrow();
    expect(touched).toBe(false);
  });

  it("does not throw on a <canvas> with drawn content", () => {
    document.body.innerHTML = `<canvas id="c" width="10" height="10"></canvas>`;
    const html = snapshotDom(document, {});
    expect(html).toContain("<canvas");
  });

  it("does not throw on a <template>", () => {
    document.body.innerHTML = `<template id="t"><input value="x"></template><p>kept</p>`;
    const html = snapshotDom(document, {});
    expect(html).toContain("kept");
  });

  it("does not throw on an SVG with <use>", () => {
    document.body.innerHTML = `
      <svg><defs><circle id="dot" r="2"/></defs><use href="#dot"></use></svg>`;
    const html = snapshotDom(document, {});
    expect(html).toContain("<use");
  });

  it("does not throw on a very large document", () => {
    const parts = [];
    for (let i = 0; i < 6000; i += 1) parts.push(`<div>row ${i}</div>`);
    document.body.innerHTML = parts.join("");
    expect(() => snapshotDom(document, {})).not.toThrow();
  });

  it("returns undefined and warns once, instead of throwing, when cloneNode itself fails", () => {
    document.body.innerHTML = `<input id="a" value="x">`;
    const original = document.documentElement.cloneNode;
    document.documentElement.cloneNode = () => {
      throw new Error("hostile cloneNode");
    };
    const warned = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warned.push(msg);
    try {
      expect(() => snapshotDom(document, {})).not.toThrow();
      expect(snapshotDom(document, {})).toBe(undefined);
      expect(warned.length).toBeGreaterThan(0);
      expect(warned[0]).toContain("dom snapshot");
    } finally {
      document.documentElement.cloneNode = original;
      console.warn = originalWarn;
    }
  });

  it("still masks a password whose type is flipped by script after render", () => {
    document.body.innerHTML = `<input id="p" type="text">`;
    const input = document.getElementById("p");
    input.value = "hunter2";
    input.type = "password"; // set by script after the element already exists
    expect(snapshotDom(document, {})).not.toContain("hunter2");
  });

  it("reads a value set by the .value property, not just the value attribute", () => {
    document.body.innerHTML = `<input id="a">`;
    // No `value=` attribute in markup at all — only the live property is set, exactly the way a
    // real form field holds what the user typed.
    document.getElementById("a").value = "typed-in";
    expect(snapshotDom(document, {})).toContain('value="typed-in"');
  });
});

describe("blankElements", () => {
  it("clears a value attribute when the blank selector matches the <input> itself", () => {
    // `<input>` is a void element: it can carry no children, so clearing textContent (which is
    // what blanking a *container* around a field relies on) is a no-op on the input itself. If
    // blankElements only cleared textContent, the value attribute stampValues just wrote in would
    // survive untouched and the snapshot would show it — the reverse of what `blank` promises.
    document.body.innerHTML = `<input id="a" class="sku-price">`;
    document.getElementById("a").value = "4200";
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("4200");
    expect(html).toContain(BLANKED_ATTR);
  });

  it("clears a checked box when the blank selector matches it directly", () => {
    document.body.innerHTML = `<input id="a" class="sku-price" type="checkbox">`;
    document.getElementById("a").checked = true;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("checked");
  });

  it("still removes the whole subtree when the selector matches an ancestor of a field", () => {
    document.body.innerHTML = `<div class="sku-price"><input id="a" value="4200"></div>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("4200");
    expect(html).not.toContain("<input");
  });

  it("does nothing when the selector matches nothing", () => {
    document.body.innerHTML = `<p>keep</p>`;
    expect(() => blankElements(document.body, [".does-not-exist"])).not.toThrow();
    expect(document.body.innerHTML).toContain("keep");
  });
});

describe("stampValues", () => {
  it("never writes to the live element, only to the clone", () => {
    document.body.innerHTML = `<input id="a">`;
    document.getElementById("a").value = "live-value";
    const clone = document.documentElement.cloneNode(true);
    stampValues(document.documentElement, clone, {});
    expect(document.getElementById("a").getAttribute("value")).toBe(null);
    expect(document.getElementById("a").value).toBe("live-value");
  });
});
