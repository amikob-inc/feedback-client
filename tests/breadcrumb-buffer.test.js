/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREADCRUMBS_KEEP,
  MASKED,
  describeClickTarget,
  describeFieldChange,
  fieldLabel,
  hiddenTarget,
  installBreadcrumbBuffer,
  usableSelector,
} from "../src/buffers/breadcrumbs.js";
import { resetWarnings } from "../src/warn.js";

const at = () => "2026-09-21T10:00:00.000Z";

beforeEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

describe("describeClickTarget", () => {
  it("is the tag, the id, up to three data attributes, the aria-label and the text", () => {
    document.body.innerHTML = `
      <button id="save-ring" data-view="rings" data-kind="primary" data-x="1" data-y="2"
              aria-label="Save">Save ring</button>`;
    const el = document.getElementById("save-ring");
    expect(describeClickTarget(el)).toBe(
      'button#save-ring[data-view="rings"][data-kind="primary"][data-x="1"] aria-label="Save" \'Save ring\'',
    );
  });

  it("cuts the text at 60 characters and collapses whitespace", () => {
    document.body.innerHTML = `<a href="#x">${"word ".repeat(30)}</a>`;
    const described = describeClickTarget(document.querySelector("a"));
    expect(described).toBe(`a '${"word ".repeat(30).replace(/\s+/g, " ").trim().slice(0, 60)}'`);
  });

  it("collapses newlines in the text like any other whitespace", () => {
    document.body.innerHTML = `<button id="b">Save\n  ring\nnow</button>`;
    expect(describeClickTarget(document.getElementById("b"))).toBe("button#b 'Save ring now'");
  });

  it("is empty for nothing", () => expect(describeClickTarget(null)).toBe(""));

  it("does not crash on a detached node and still describes it", () => {
    const el = document.createElement("button");
    el.id = "ghost";
    el.textContent = "Ghost";
    // Deliberately never appended to document.body.
    expect(describeClickTarget(el)).toBe("button#ghost 'Ghost'");
  });

  it("describes an SVG element, whose className is not a plain string, without crashing", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("id", "icon");
    svg.setAttribute("data-view", "rings");
    svg.setAttribute("aria-label", "Open rings");
    document.body.appendChild(svg);
    expect(describeClickTarget(svg)).toBe('svg#icon[data-view="rings"] aria-label="Open rings"');
  });

  it("describes a label wrapping an input as the label itself, without crashing", () => {
    document.body.innerHTML = `<label id="pair-label">Pair<input type="checkbox"></label>`;
    const el = document.getElementById("pair-label");
    expect(describeClickTarget(el)).toBe("label#pair-label 'Pair'");
  });

  it("still only records three data attributes when the element has 200, and stays fast", () => {
    const button = document.createElement("button");
    button.id = "b";
    for (let i = 0; i < 200; i += 1) button.setAttribute(`data-x${i}`, String(i));
    document.body.appendChild(button);
    const started = Date.now();
    const described = describeClickTarget(button);
    const elapsed = Date.now() - started;
    expect(described).toBe('button#b[data-x0="0"][data-x1="1"][data-x2="2"]');
    expect(elapsed).toBeLessThan(50);
  });
});

describe("fieldLabel", () => {
  it("prefers the label element", () => {
    document.body.innerHTML = `<label for="a">Ring name</label><input id="a">`;
    expect(fieldLabel(document.getElementById("a"))).toBe("Ring name");
  });
  it("then the aria-label, then the placeholder, then the name", () => {
    document.body.innerHTML = `
      <input id="b" aria-label="Carat">
      <input id="c" placeholder="Search">
      <input id="d" name="metal">
      <input id="e">`;
    expect(fieldLabel(document.getElementById("b"))).toBe("Carat");
    expect(fieldLabel(document.getElementById("c"))).toBe("Search");
    expect(fieldLabel(document.getElementById("d"))).toBe("metal");
    expect(fieldLabel(document.getElementById("e"))).toBe("input");
  });
  it("falls back to the tag name when there is no label anywhere", () => {
    document.body.innerHTML = `<textarea id="f"></textarea>`;
    expect(fieldLabel(document.getElementById("f"))).toBe("textarea");
  });
});

describe("describeFieldChange", () => {
  it("cuts the value at 40 characters", () => {
    document.body.innerHTML = `<input id="a" aria-label="Note">`;
    const el = document.getElementById("a");
    el.value = "y".repeat(60);
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe(`Note = '${"y".repeat(40)}'`);
  });

  it("always masks a password", () => {
    document.body.innerHTML = `<input id="p" type="password" aria-label="Password">`;
    const el = document.getElementById("p");
    el.value = "hunter2";
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe(`Password = ${MASKED}`);
  });

  it("masks everything under maskAllInputs", () => {
    document.body.innerHTML = `<input id="a" aria-label="Note">`;
    const el = document.getElementById("a");
    el.value = "visible";
    expect(describeFieldChange(el, { maskAllInputs: true })).toBe(`Note = ${MASKED}`);
  });

  it("describes a checkbox by its state, masked or not", () => {
    document.body.innerHTML = `<input id="c" type="checkbox" aria-label="Pair">`;
    const el = document.getElementById("c");
    el.checked = true;
    expect(describeFieldChange(el, { maskAllInputs: true })).toBe("Pair = checked");
  });

  it("never records a file's path, masked or not", () => {
    document.body.innerHTML = `<input id="f" type="file" aria-label="Attachment">`;
    const el = document.getElementById("f");
    // A real browser would put a fake "C:\fakepath\..." in `.value`; jsdom leaves it "". Either
    // way, `.value` must never be read for a file input — only the count of files chosen.
    Object.defineProperty(el, "files", {
      value: [{ name: "secret.txt" }, { name: "second.txt" }],
      configurable: true,
    });
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe("Attachment = 2 files");
    expect(describeFieldChange(el, { maskAllInputs: true })).toBe(`Attachment = ${MASKED}`);
  });

  it("describes zero or one chosen file with correct pluralisation", () => {
    document.body.innerHTML = `<input id="f" type="file" aria-label="Attachment">`;
    const el = document.getElementById("f");
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe("Attachment = 0 files");
    Object.defineProperty(el, "files", { value: [{ name: "one.stl" }], configurable: true });
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe("Attachment = 1 file");
  });

  it("joins every selected option of a <select multiple>, not just the first", () => {
    document.body.innerHTML = `
      <select id="s" multiple aria-label="Stones">
        <option value="ruby">Ruby</option>
        <option value="sapphire">Sapphire</option>
        <option value="topaz">Topaz</option>
      </select>`;
    const el = document.getElementById("s");
    el.options[0].selected = true;
    el.options[2].selected = true;
    expect(describeFieldChange(el, { maskAllInputs: false })).toBe("Stones = 'ruby, topaz'");
  });

  it("masks a <select multiple> under maskAllInputs like any other field", () => {
    document.body.innerHTML = `
      <select id="s" multiple aria-label="Stones">
        <option value="ruby">Ruby</option>
      </select>`;
    const el = document.getElementById("s");
    el.options[0].selected = true;
    expect(describeFieldChange(el, { maskAllInputs: true })).toBe(`Stones = ${MASKED}`);
  });
});

describe("installBreadcrumbBuffer", () => {
  it("records the nearest button for a click on its child", () => {
    document.body.innerHTML = `<button id="b"><span id="s">Go</span></button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    document.getElementById("s").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()).toEqual([{ t: at(), kind: "click", target: "button#b 'Go'" }]);
    buffer.uninstall();
  });

  it("records a click whose event target is an SVG icon inside a button", () => {
    document.body.innerHTML = `<button id="icon-btn"><svg id="icon"><path></path></svg></button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    document
      .getElementById("icon")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()).toEqual([{ t: at(), kind: "click", target: "button#icon-btn" }]);
    buffer.uninstall();
  });

  it("records a change, a submit, a route change, visibility and connection", () => {
    document.body.innerHTML = `<form id="f"><input id="a" aria-label="Note"></form>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    const input = document.getElementById("a");
    input.value = "hi";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.getElementById("f").dispatchEvent(new window.Event("submit", { bubbles: true }));
    window.history.pushState({}, "", "/rings#batch-3");
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.dispatchEvent(new window.Event("offline"));
    expect(buffer.entries().map((e) => [e.kind, e.target])).toEqual([
      ["change", "Note = 'hi'"],
      ["submit", "form#f"],
      ["route", "/rings#batch-3"],
      ["visibility", document.visibilityState],
      ["connection", "offline"],
    ]);
    buffer.uninstall();
  });

  it("also records a route change from replaceState", () => {
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    window.history.replaceState({}, "", "/rings/7");
    expect(buffer.entries()).toEqual([{ t: at(), kind: "route", target: "/rings/7" }]);
    buffer.uninstall();
  });

  it("never records a query string in a route breadcrumb", () => {
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    window.history.pushState({}, "", "/rings?token=secret#x");
    expect(buffer.entries()[0].target).toBe("/rings#x");
    buffer.uninstall();
  });

  it("keeps the last 100", () => {
    document.body.innerHTML = `<button id="b">Go</button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    const button = document.getElementById("b");
    for (let i = 0; i < BREADCRUMBS_KEEP + 7; i += 1) {
      button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    }
    expect(buffer.entries()).toHaveLength(BREADCRUMBS_KEEP);
    buffer.uninstall();
  });

  it("restores history.pushState and replaceState and stops recording on uninstall", () => {
    const beforePush = window.history.pushState;
    const beforeReplace = window.history.replaceState;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    expect(window.history.pushState).not.toBe(beforePush);
    expect(window.history.replaceState).not.toBe(beforeReplace);
    buffer.uninstall();
    expect(window.history.pushState).toBe(beforePush);
    expect(window.history.replaceState).toBe(beforeReplace);
    window.history.pushState({}, "", "/after");
    expect(buffer.entries()).toEqual([]);
  });

  it("leaves a pushState patch installed after this one alone on uninstall", () => {
    const originalPush = window.history.pushState;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    const laterPatch = function laterPush() {};
    window.history.pushState = laterPatch;
    try {
      buffer.uninstall();
      expect(window.history.pushState).toBe(laterPatch);
    } finally {
      window.history.pushState = originalPush;
    }
  });

  it("leaves a replaceState patch installed after this one alone on uninstall", () => {
    const originalReplace = window.history.replaceState;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    const laterPatch = function laterReplace() {};
    window.history.replaceState = laterPatch;
    try {
      buffer.uninstall();
      expect(window.history.replaceState).toBe(laterPatch);
    } finally {
      window.history.replaceState = originalReplace;
    }
  });

  it("is safe to call uninstall twice", () => {
    const beforePush = window.history.pushState;
    const beforeReplace = window.history.replaceState;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    buffer.uninstall();
    expect(() => buffer.uninstall()).not.toThrow();
    expect(window.history.pushState).toBe(beforePush);
    expect(window.history.replaceState).toBe(beforeReplace);
  });

  it("still pushes state, falls back and warns once when recording the breadcrumb throws", () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const buffer = installBreadcrumbBuffer({
      target: window,
      doc: document,
      now: () => {
        throw new Error("clock broke");
      },
    });
    expect(() => window.history.pushState({}, "", "/one")).not.toThrow();
    expect(window.location.pathname).toBe("/one");
    expect(() => window.history.pushState({}, "", "/two")).not.toThrow();
    expect(window.location.pathname).toBe("/two");
    expect(buffer.entries()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    buffer.uninstall();
  });
});

// A describer reads the page, not just the event: it takes an element's id, data attributes,
// aria-label and text, and a field's label, aria-label, placeholder and name. All of that is page
// content, so the selectors an app passes in `capture.blank` have to reach here too. Every case
// below was found by the marker harness (tests/leak-matrix.test.js, the `channel/click-*` and
// `channel/change-*` positions), which watched a cost price planted in a blanked button's text
// come out in the report's breadcrumb trail.
describe("installBreadcrumbBuffer with capture.blank", () => {
  const blank = [".sku-price"];

  it("withholds a clicked element's text, aria-label, data attributes and id", () => {
    document.body.innerHTML = `<div class="sku-price"><button id="cost-1240" data-cost="1240" aria-label="Cost GBP 1,240">Cost GBP 1,240</button></div>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at, blank });
    document
      .getElementById("cost-1240")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()).toEqual([{ t: at(), kind: "click", target: "button (hidden)" }]);
    buffer.uninstall();
  });

  it("withholds a changed field's label, placeholder, name and value", () => {
    document.body.innerHTML = `<div class="sku-price"><label>Cost price<input id="c" name="cost_gbp" placeholder="1240.00"></label></div>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at, blank });
    const input = document.getElementById("c");
    input.value = "1240.00";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    expect(buffer.entries()).toEqual([{ t: at(), kind: "change", target: "input (hidden)" }]);
    buffer.uninstall();
  });

  it("withholds a submitted form's description", () => {
    document.body.innerHTML = `<div class="sku-price"><form id="f" data-customer="ada@example.com"></form></div>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at, blank });
    document.getElementById("f").dispatchEvent(new window.Event("submit", { bubbles: true }));
    expect(buffer.entries()).toEqual([{ t: at(), kind: "submit", target: "form (hidden)" }]);
    buffer.uninstall();
  });

  it("still records the breadcrumb, so the trail is not full of holes", () => {
    document.body.innerHTML = `<div class="sku-price"><button id="a">Cost</button></div><button id="b">Rings</button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at, blank });
    for (const id of ["a", "b"]) {
      document.getElementById(id).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    }
    expect(buffer.entries().map((one) => one.target)).toEqual([
      "button (hidden)",
      "button#b 'Rings'",
    ]);
    buffer.uninstall();
  });

  it("describes everything outside the blanked elements as before", () => {
    document.body.innerHTML = `<div class="sku-price">hidden</div><button id="b" data-view="rings">Rings</button>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at, blank });
    document.getElementById("b").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()[0].target).toBe(`button#b[data-view="rings"] 'Rings'`);
    buffer.uninstall();
  });

  it("keeps the selectors it can use when one of them is not a selector at all", () => {
    document.body.innerHTML = `<div class="sku-price"><button id="a">Cost</button></div>`;
    const buffer = installBreadcrumbBuffer({
      target: window,
      doc: document,
      now: at,
      blank: ["!!! not a selector", ".sku-price"],
    });
    document.getElementById("a").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()[0].target).toBe("button (hidden)");
    buffer.uninstall();
  });

  it("describes normally when no blank selectors were given", () => {
    document.body.innerHTML = `<div class="sku-price"><button id="a">Cost</button></div>`;
    const buffer = installBreadcrumbBuffer({ target: window, doc: document, now: at });
    document.getElementById("a").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(buffer.entries()[0].target).toBe("button#a 'Cost'");
    buffer.uninstall();
  });
});

describe("usableSelector", () => {
  it("drops what the engine cannot parse and keeps the rest", () => {
    expect(usableSelector(document, [".a", "!!!", "#b", "", null, 7])).toBe(".a,#b");
    expect(usableSelector(document, [])).toBe("");
    expect(usableSelector(document, undefined)).toBe("");
  });
});

describe("hiddenTarget", () => {
  it("names the tag and nothing else", () => {
    expect(hiddenTarget(document.createElement("button"))).toBe("button (hidden)");
    expect(hiddenTarget(null)).toBe("(hidden)");
    expect(hiddenTarget({})).toBe("(hidden)");
  });
});
