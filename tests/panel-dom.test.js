/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { clear, el, firstLine, relativeTime } from "../src/panel/dom.js";

describe("el", () => {
  it("builds an element with attributes, text and children", () => {
    const child = el(document, "span", { text: "inner" });
    const node = el(document, "button", { class: "fbh-btn", id: "go", "aria-label": "Go" }, [
      child,
    ]);
    expect(node.outerHTML).toBe(
      '<button class="fbh-btn" id="go" aria-label="Go"><span>inner</span></button>',
    );
  });

  it("wires a listener and skips nothing-values", () => {
    const onClick = vi.fn();
    const node = el(document, "button", { onClick, title: null, disabled: false, hidden: true });
    node.dispatchEvent(new window.MouseEvent("click"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("disabled")).toBe(false);
    expect(node.hasAttribute("hidden")).toBe(true);
  });

  it("never interprets text as markup", () => {
    const node = el(document, "p", { text: "<img src=x onerror=alert(1)>" });
    expect(node.querySelector("img")).toBe(null);
    expect(node.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("clear", () => {
  it("empties a node", () => {
    const node = el(document, "div", {}, [el(document, "b", { text: "x" })]);
    clear(node);
    expect(node.childNodes).toHaveLength(0);
  });
});

describe("firstLine", () => {
  it("is the first line, cut", () => {
    expect(firstLine("one\ntwo", 20)).toBe("one");
    expect(firstLine("a".repeat(30), 10)).toBe(`${"a".repeat(10)}…`);
    expect(firstLine("   padded  ", 20)).toBe("padded");
    expect(firstLine(undefined, 20)).toBe("");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");
  it("reads as a person would say it", () => {
    expect(relativeTime("2026-09-21T11:59:30.000Z", now)).toBe("just now");
    expect(relativeTime("2026-09-21T11:45:00.000Z", now)).toBe("15 min ago");
    expect(relativeTime("2026-09-21T09:00:00.000Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-20T12:00:00.000Z", now)).toBe("1 day ago");
    expect(relativeTime("2026-09-18T12:00:00.000Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-08-01T12:00:00.000Z", now)).toBe("2026-08-01");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
