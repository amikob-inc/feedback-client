/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOptions } from "../src/options.js";
import { FOCUSABLE, HOST_ID, createPanel } from "../src/panel/panel.js";
import { THEME_PROPERTIES } from "../src/panel/styles.js";

function setup({ theme = () => "light" } = {}) {
  const api = {
    submit: vi.fn(async () => ({ id: "r1", dropped: [] })),
    captureScreenshot: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    reply: vi.fn(),
    retry: vi.fn(),
    markRead: vi.fn(),
  };
  const options = normalizeOptions({
    hubUrl: "https://hub.example",
    app: "cad",
    getToken: async () => "t",
    sections: ["Rendering", "General"],
    types: ["Bug", "Question"],
    theme,
    capture: { screenshot: false, replay: false },
  });
  const panel = createPanel({ api, options, doc: document });
  return { api, panel };
}

const shadow = () => document.getElementById(HOST_ID).shadowRoot;

beforeEach(() => {
  document.body.innerHTML = "";
  // A stray inline value left over from a broken test elsewhere would make the scroll-lock
  // assertions below meaningless (see "restores exactly" below, which depends on knowing what
  // was there beforehand).
  document.documentElement.style.overflow = "";
});

describe("createPanel", () => {
  it("puts one host with a shadow root on the page, closed", () => {
    const { panel } = setup();
    const host = document.getElementById(HOST_ID);
    expect(host).not.toBe(null);
    expect(host.shadowRoot).not.toBe(null);
    expect(shadow().querySelector(".fbh-overlay").hidden).toBe(true);
    expect(panel.isOpen()).toBe(false);
    panel.destroy();
    expect(document.getElementById(HOST_ID)).toBe(null);
  });

  it("carries the thirteen theming properties and a dark block", () => {
    const { panel } = setup();
    const css = shadow().querySelector("style").textContent;
    for (const property of THEME_PROPERTIES) expect(css).toContain(`${property}:`);
    expect(THEME_PROPERTIES).toHaveLength(13);
    expect(css).toContain(':host([data-theme="dark"])');
    panel.destroy();
  });

  it("is a modal dialog with a label, and opens with the app's theme", () => {
    const { panel } = setup({ theme: () => "dark" });
    panel.open();
    const overlay = shadow().querySelector(".fbh-overlay");
    expect(overlay.getAttribute("role")).toBe("dialog");
    expect(overlay.getAttribute("aria-modal")).toBe("true");
    expect(overlay.getAttribute("aria-labelledby")).toBe("fbh-title");
    expect(shadow().getElementById("fbh-title").textContent).toBe("Report an issue or suggestion");
    expect(document.getElementById(HOST_ID).dataset.theme).toBe("dark");
    expect(overlay.hidden).toBe(false);
    panel.destroy();
  });

  it("starts and stops the list polling with the panel", () => {
    vi.useFakeTimers();
    try {
      const { panel, api } = setup();
      panel.open();
      expect(api.list).toHaveBeenCalledTimes(1);

      // The poll is the point of the assertion: a closed panel must not keep asking the hub every
      // thirty seconds. Advancing the clock past two intervals with the panel shut is what proves
      // close() really stopped it — counting calls at the moment of closing proves nothing, since
      // the next tick had not arrived yet either way.
      // Three more ticks at the list's thirty-second interval, on top of the one open() made.
      vi.advanceTimersByTime(90_000);
      expect(api.list).toHaveBeenCalledTimes(4);

      panel.close();
      expect(panel.isOpen()).toBe(false);
      const afterClose = api.list.mock.calls.length;
      vi.advanceTimersByTime(90_000);
      expect(api.list).toHaveBeenCalledTimes(afterClose);
      panel.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  // open() on an open panel is a real path, not a theoretical one: the mount calls it twice for
  // two clicks while the panel's chunk is still loading. Without the guard the second call
  // records a control inside the panel as "where focus came from", and close() then hands focus
  // back into the hidden dialog instead of to the app's button.
  it("ignores open() while already open, so close() still gives focus back to the app", () => {
    document.body.innerHTML = `<button id="opener"></button>`;
    const opener = document.getElementById("opener");
    const { panel } = setup();
    opener.focus();
    panel.open();
    panel.open();
    expect(document.activeElement).not.toBe(opener); // focus really did move into the panel
    panel.close();
    expect(document.activeElement).toBe(opener);
    panel.destroy();
  });

  it("closes on Escape, on the close button and on the backdrop, and gives focus back", () => {
    document.body.innerHTML = `<button id="opener"></button>`;
    const opener = document.getElementById("opener");
    const { panel } = setup();
    opener.focus();
    panel.open();
    shadow()
      .querySelector(".fbh-overlay")
      .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);

    panel.open();
    shadow().querySelector(".fbh-close").click();
    expect(panel.isOpen()).toBe(false);

    panel.open();
    shadow()
      .querySelector(".fbh-overlay")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(panel.isOpen()).toBe(false);
    panel.destroy();
  });

  it("keeps Tab inside the panel", () => {
    const { panel } = setup();
    panel.open();
    const root = shadow();
    const focusable = [...root.querySelectorAll("button, select, textarea, input, a[href]")].filter(
      (node) => !node.hidden,
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    const forward = new window.KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    root.querySelector(".fbh-overlay").dispatchEvent(forward);
    expect(root.activeElement).toBe(first);

    const backward = new window.KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    root.querySelector(".fbh-overlay").dispatchEvent(backward);
    expect(root.activeElement).toBe(last);
    panel.destroy();
  });

  // theme() is an app hook (spec §5.4), and the library may never break the host
  // application"): a throw, or a value that is not literally "dark", must fall back to light
  // rather than take the panel down. A naive `options.theme() === "dark"` with no guard fails
  // this the instant theme() throws.
  describe("a broken theme() hook", () => {
    it("does not stop the panel from opening, and defaults to light", () => {
      const { panel } = setup({
        theme: () => {
          throw new Error("boom");
        },
      });
      expect(() => panel.open()).not.toThrow();
      expect(document.getElementById(HOST_ID).dataset.theme).toBe("light");
      panel.destroy();
    });

    it("treats anything other than the string 'dark' as light", () => {
      const { panel } = setup({ theme: () => 42 });
      panel.open();
      expect(document.getElementById(HOST_ID).dataset.theme).toBe("light");
      panel.destroy();
    });
  });

  // Standing rule 4 again, the other half: "the host element must not disturb the page's layout
  // or scrolling; closing must restore whatever the page had." A fixed-position overlay covering
  // the viewport still lets a wheel or touch gesture over its own backdrop scroll the *page*
  // behind it (the overlay establishes no scroll container of its own) unless something locks
  // page scrolling while the dialog is open — and whatever it sets must come back exactly, not
  // merely be cleared, in case the app had already set something of its own.
  describe("scroll lock", () => {
    it("locks page scroll while open and restores exactly what was there before, on close", () => {
      document.documentElement.style.overflow = "scroll"; // simulate the app's own prior value
      const { panel } = setup();
      panel.open();
      expect(document.documentElement.style.overflow).toBe("hidden");
      panel.close();
      expect(document.documentElement.style.overflow).toBe("scroll");
      panel.destroy();
    });

    it("restores an absent value (no inline overflow at all) rather than leaving 'hidden' behind", () => {
      const { panel } = setup();
      expect(document.documentElement.style.overflow).toBe("");
      panel.open();
      expect(document.documentElement.style.overflow).toBe("hidden");
      panel.close();
      expect(document.documentElement.style.overflow).toBe("");
      panel.destroy();
    });

    it("unlocks on destroy even when close() was never called", () => {
      const { panel } = setup();
      panel.open();
      panel.destroy();
      expect(document.documentElement.style.overflow).toBe("");
    });
  });

  // The annotator (src/panel/annotate.js) opens its own dialog, class "fbh-annotator", on top of
  // the panel while the panel's own dialog stays open underneath it — a trap inside a trap (task
  // brief item 2). It has no Tab-cycling of its own, only Escape, so the *panel's* trap has to
  // notice it and narrow itself to it; and Escape has to close the inner one first, not both at
  // once. jsdom cannot exercise annotate.js's real open (loading a blob image never settles there
  // — see annotate.js's and tests/form.test.js's own notes), so this reaches in and plants the
  // exact DOM shape annotate.js produces, to prove panel.js's own reaction to it — the boundary
  // this task owns — independent of whether this environment can drive the rest of that flow.
  describe("a nested dialog (the annotator) on top of the panel", () => {
    function plantAnnotator() {
      const dialog = document.createElement("div");
      dialog.className = "fbh-annotator";
      const undo = document.createElement("button");
      undo.type = "button";
      undo.textContent = "Undo";
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Save";
      dialog.append(undo, save);
      shadow().querySelector(".fbh-body").appendChild(dialog);
      return { dialog, undo, save };
    }

    it("scopes Tab to the nested dialog instead of the rest of the panel", () => {
      const { panel } = setup();
      panel.open();
      const { undo, save } = plantAnnotator();
      const root = shadow();
      save.focus();
      root
        .querySelector(".fbh-overlay")
        .dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
      // Wraps to the *other button inside the nested dialog*, never to the panel's own Close
      // button or any form/list control behind it.
      expect(root.activeElement).toBe(undo);

      root.querySelector(".fbh-overlay").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(root.activeElement).toBe(save);
      panel.destroy();
    });

    it("lets the nested dialog handle its own Escape instead of closing the whole panel", () => {
      const { panel } = setup();
      panel.open();
      plantAnnotator();
      const seenAtDocument = vi.fn();
      // composed: true, because that is what a real keydown is (UA-dispatched input events cross
      // shadow boundaries by default); annotate.js's own Escape listener lives on `doc`, outside
      // the shadow tree entirely, and only ever sees the event if this handler leaves it alone.
      document.addEventListener("keydown", seenAtDocument, { once: true });
      shadow()
        .querySelector(".fbh-overlay")
        .dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
        );
      expect(panel.isOpen()).toBe(true); // the panel itself stayed open
      expect(seenAtDocument).toHaveBeenCalledTimes(1); // and the event reached the outer listener
      panel.destroy();
    });

    it("still closes on Escape, and still stops it there, once nothing nested is open", () => {
      const { panel } = setup();
      panel.open();
      const seenAtDocument = vi.fn();
      document.addEventListener("keydown", seenAtDocument, { once: true });
      shadow()
        .querySelector(".fbh-overlay")
        .dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
        );
      expect(panel.isOpen()).toBe(false);
      expect(seenAtDocument).not.toHaveBeenCalled();
      panel.destroy();
    });
  });

  // Standing rule 2's other edge: "cope ... with the dialog containing no focusable element yet."
  // A naive `if (items.length) items[0].focus()` leaves focus wherever it already was — outside
  // the dialog entirely — the moment the dialog is (even transiently) empty.
  it("still moves focus into the dialog when nothing inside it is focusable", () => {
    const { panel } = setup();
    panel.open();
    // `disabled`, not tabindex: a <button>/<select>/<textarea>/<input> matches FOCUSABLE on its
    // own type regardless of tabindex (that branch of the selector only ever excludes a plain
    // [tabindex]-only element, of which the panel has none), so `:not([disabled])` is the one
    // lever that actually empties the set here.
    for (const node of shadow().querySelectorAll(FOCUSABLE)) node.disabled = true;
    panel.close();
    expect(() => panel.open()).not.toThrow();
    expect(shadow().activeElement).toBe(shadow().querySelector(".fbh-panel"));
    panel.destroy();
  });

  // Isolation, in both directions. jsdom's own CSS engine does not implement
  // Shadow DOM style scoping faithfully (confirmed by hand: a light-DOM `button { color: ... }`
  // rule bleeds into shadow content under getComputedStyle here, which real Chromium/Firefox/
  // WebKit never do), so a computed-style assertion here would be testing jsdom's gaps, not this
  // code — genuine visual survival under a hostile page stylesheet needs a real browser (a
  // Playwright check, not this file). What jsdom *can* prove, reliably, is the structural half of
  // the guarantee: a light-DOM selector — `*` included — simply cannot reach past a shadow
  // boundary at all, and the panel keeps working (opens, closes, responds to Escape) with a
  // maximally hostile stylesheet sitting in the same document.
  describe("isolation", () => {
    it("keeps working under a page with an aggressive global reset", () => {
      const reset = document.createElement("style");
      reset.textContent = "* { display: none !important; } button { all: unset !important; }";
      document.head.appendChild(reset);
      const { panel } = setup();
      expect(() => panel.open()).not.toThrow();
      expect(shadow().querySelector(".fbh-overlay").hidden).toBe(false);
      shadow()
        .querySelector(".fbh-overlay")
        .dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(panel.isOpen()).toBe(false);
      panel.destroy();
      document.head.removeChild(reset);
    });

    it("keeps everything it defines out of reach of the page's own selectors", () => {
      const { panel } = setup();
      panel.open();
      expect(document.querySelector(".fbh-overlay")).toBe(null);
      expect(document.querySelector(".fbh-title")).toBe(null);
      expect(document.getElementById("fbh-title")).toBe(null);
      expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
      panel.destroy();
    });

    it("never writes its stylesheet into the page's own document", () => {
      // Snapshotted before setup() even builds the panel: construction is where the <style> is
      // created and inserted, so a leak could happen there just as easily as in open(), and a
      // "before" taken after setup() would never see it either way.
      const before = [...document.head.querySelectorAll("style")].map((node) => node.textContent);
      const { panel } = setup();
      const afterBuild = [...document.head.querySelectorAll("style")].map(
        (node) => node.textContent,
      );
      panel.open();
      const afterOpen = [...document.head.querySelectorAll("style")].map(
        (node) => node.textContent,
      );
      expect(afterBuild).toEqual(before);
      expect(afterOpen).toEqual(before);
      panel.destroy();
    });
  });
});

describe("the host element", () => {
  // The panel defends itself against a page-wide reset with `display: block !important`, and a
  // shadow tree's !important beats the outer page's — so without an escape hatch a dashboard
  // could not hide its own host element on purpose. `hidden` is that hatch.
  it("declares a hidden host as display: none", () => {
    const { panel } = setup();
    panel.open();
    const css = document.getElementById("fbh-host").shadowRoot.querySelector("style").textContent;
    const hiddenRule = css.slice(css.indexOf(":host([hidden])"));
    expect(hiddenRule).toMatch(/display:\s*none\s*!important/);
    panel.destroy();
  });
});
