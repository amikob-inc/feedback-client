/** @vitest-environment jsdom */
// jsdom has no layout: every rect below is handed in through the `rectOf` seam, and the scroll
// offsets are set on elements directly. The browser test (e2e/panel.spec.js, "captures the
// viewport") is where the real thing is settled: the picture's size and what is in it.
import { describe, expect, it } from "vitest";
import {
  HOST_ID,
  SCREENSHOT_STYLE_PROPERTIES,
  SCROLL_ATTRIBUTE,
  applyScrollOffset,
  markScrolled,
  viewportOptions,
} from "../src/capture/viewport.js";

function box(top, height, left = 0, width = 100) {
  return { top, bottom: top + height, left, right: left + width, width, height };
}

// A page: the target, a card on screen, a card below the fold whose child would be off screen as
// well, and a card far below that.
function page() {
  document.body.innerHTML = `
    <div id="on"><span id="on-child">x</span><span id="on-tail"><i id="on-tail-child"></i></span></div>
    <div id="below"><span id="below-child">y</span></div>
    <div id="far"><span id="far-child">z</span></div>
    <div id="none"><span id="none-child">n</span></div>
    <div id="contents"><span id="contents-child">c</span></div>
    <div id="${HOST_ID}"></div>
  `;
  const rects = {
    on: box(100, 200),
    "on-child": box(120, 20),
    "on-tail": box(2500, 20),
    "on-tail-child": box(2500, 20),
    below: box(2000, 200),
    "below-child": box(2020, 20),
    far: box(5000, 200),
    "far-child": box(5020, 20),
    none: box(0, 0, 0, 0),
    "none-child": box(0, 0, 0, 0),
    contents: box(0, 0, 0, 0),
    "contents-child": box(300, 20),
  };
  document.getElementById("contents").style.display = "contents";
  const rectOf = (node) => rects[node.id] || box(0, 10);
  const isRendered = (node) => !["none", "none-child", "contents"].includes(node.id);
  return { rectOf, isRendered, byId: (id) => document.getElementById(id) };
}
const laidOut = { isRendered: () => true };

describe("viewportOptions", () => {
  it("sizes the picture to the window, and shifts it so the first on-screen child sits where it was", () => {
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    Object.defineProperty(window, "scrollX", { value: 0, configurable: true });
    document.body.innerHTML = `
      <div id="above"></div>
      <div id="fixed" style="position: fixed"></div>
      <div id="anchor" style="margin-top: 10px"></div>
      <div id="rest"></div>
    `;
    document.body.style.paddingTop = "24px";
    document.body.style.borderTop = "2px solid black";
    const rects = {
      above: box(-2000, 100),
      fixed: box(0, 40),
      anchor: box(-930, 1585),
      rest: box(655, 40),
    };
    const options = viewportOptions(document.body, {
      rectOf: (node) => rects[node.id] || box(0, 0, 0, 0),
      isRendered: () => true,
    });
    expect(options.width).toBe(1440);
    expect(options.height).toBe(900);
    // The anchor is the first child in normal flow that is on screen (the fixed one is skipped);
    // in the clone it sits at the root's padding and border plus its own margin.
    expect(options.style).toEqual({ transform: "translate(0px, -966px)" });
    expect(options.includeStyleProperties).toBe(SCREENSHOT_STYLE_PROPERTIES);
    const clone = document.createElement("div");
    options.onCloneNode(clone);
    expect(clone.style.getPropertyValue("height")).toBe("auto");
    expect(clone.style.getPropertyPriority("height")).toBe("important");
    document.body.style.paddingTop = "";
    document.body.style.borderTop = "";
  });

  it("shifts nothing when the page is at the top", () => {
    document.body.innerHTML = `<h1 id="h" style="margin-top: 0">t</h1>`;
    document.body.style.paddingTop = "24px";
    const options = viewportOptions(document.body, {
      rectOf: () => box(24, 30),
      isRendered: () => true,
    });
    expect(options.style).toEqual({ transform: "translate(0px, 0px)" });
    document.body.style.paddingTop = "";
  });

  it("keeps what is on screen, drops an off-screen child of the target, keeps a deeper off-screen box whose parent is on screen, and walks no deeper", () => {
    const { rectOf, isRendered, byId } = page();
    const { filter } = viewportOptions(document.body, { rectOf, isRendered });
    expect(filter(byId("on"))).toBe(true);
    expect(filter(byId("on-child"))).toBe(true);
    // Off screen, directly under the target: gone altogether, nothing above or below the screen
    // is laid out.
    expect(filter(byId("below"))).toBe(false);
    expect(filter(byId("far"))).toBe(false);
    // Off screen inside an on-screen parent: the box stays, the subtree goes.
    expect(filter(byId("on-tail"))).toBe(true);
    expect(filter(byId("on-tail-child"))).toBe(false);
  });

  it("drops an unrendered element but walks into a display: contents wrapper", () => {
    const { rectOf, isRendered, byId } = page();
    const { filter } = viewportOptions(document.body, { rectOf, isRendered });
    expect(filter(byId("none"))).toBe(false);
    expect(filter(byId("contents"))).toBe(true);
    expect(filter(byId("contents-child"))).toBe(true);
  });

  it("filters the panel's host out and keeps text nodes and the target itself", () => {
    const { rectOf, isRendered, byId } = page();
    const { filter } = viewportOptions(document.body, { rectOf, isRendered });
    expect(filter(byId(HOST_ID))).toBe(false);
    expect(filter(document.createTextNode("t"))).toBe(true);
    expect(filter(document.body)).toBe(true);
    expect(filter(null)).toBe(true);
  });

  it("keeps a node whose rect cannot be read, and reads each rect once", () => {
    let reads = 0;
    const rectOf = (node) => {
      reads += 1;
      if (node.id === "bad") throw new Error("no layout");
      return box(3000, 10);
    };
    document.body.innerHTML = `<div id="bad"><i id="bad-child"></i></div><div id="wrap"><p id="p"><b id="b"></b></p></div>`;
    const { filter } = viewportOptions(document.body, { rectOf, ...laidOut });
    expect(filter(document.getElementById("bad"))).toBe(true);
    expect(filter(document.getElementById("bad-child"))).toBe(true);
    // Off screen and directly under the target: dropped. Off screen under an off-screen parent:
    // dropped too.
    expect(filter(document.getElementById("wrap"))).toBe(false);
    expect(filter(document.getElementById("p"))).toBe(false);
    reads = 0;
    // The child asks for its own rect and its parent's; the parent's was already read.
    expect(filter(document.getElementById("b"))).toBe(false);
    expect(reads).toBe(1);
  });

  it("keeps everything but the host where there is no layout at all (jsdom), the whole-page capture", () => {
    document.body.innerHTML = `<div id="a"><p id="p">1</p></div><div id="${HOST_ID}"></div>`;
    // jsdom: getClientRects() is empty for every element, the body included.
    const { filter } = viewportOptions(document.body);
    expect(filter(document.getElementById("a"))).toBe(true);
    expect(filter(document.getElementById("p"))).toBe(true);
    expect(filter(document.getElementById(HOST_ID))).toBe(false);
  });

  it("lists only longhand properties, each once", () => {
    const list = SCREENSHOT_STYLE_PROPERTIES;
    expect(new Set(list).size).toBe(list.length);
    for (const name of ["margin", "padding", "border", "background", "font", "flex", "grid"]) {
      expect(list, `${name} is a shorthand`).not.toContain(name);
    }
    for (const name of [
      "width",
      "height",
      "color",
      "background-color",
      "font-family",
      "transform",
    ]) {
      expect(list).toContain(name);
    }
  });
});

describe("markScrolled and applyScrollOffset", () => {
  it("marks every scrolled element for the capture and takes the marks off again", () => {
    document.body.innerHTML = `<div id="a"><p>1</p><p>2</p></div><div id="b"></div>`;
    const a = document.getElementById("a");
    const b = document.getElementById("b");
    Object.defineProperty(a, "scrollTop", { value: 40, configurable: true });
    Object.defineProperty(a, "scrollLeft", { value: 5, configurable: true });
    const unmark = markScrolled(document.body);
    expect(a.getAttribute(SCROLL_ATTRIBUTE)).toBe("5,40");
    expect(b.hasAttribute(SCROLL_ATTRIBUTE)).toBe(false);
    unmark();
    expect(a.hasAttribute(SCROLL_ATTRIBUTE)).toBe(false);
  });

  it("shifts a marked clone's children by the offset, ahead of any transform of their own", () => {
    document.body.innerHTML = `<div id="a" ${SCROLL_ATTRIBUTE}="5,40"><p id="p">1</p><p id="q" style="transform: scale(2)">2</p></div>`;
    const a = document.getElementById("a");
    expect(applyScrollOffset(a)).toBe(true);
    expect(a.hasAttribute(SCROLL_ATTRIBUTE)).toBe(false);
    expect(document.getElementById("p").style.transform).toBe("translate(-5px, -40px)");
    expect(document.getElementById("q").style.transform).toBe("translate(-5px, -40px) scale(2)");
  });

  it("leaves an unmarked or malformed clone alone", () => {
    document.body.innerHTML = `<div id="a"><p id="p">1</p></div><div id="m" ${SCROLL_ATTRIBUTE}="x,y"><p id="mp"></p></div>`;
    expect(applyScrollOffset(document.getElementById("a"))).toBe(false);
    expect(document.getElementById("p").style.transform).toBe("");
    expect(applyScrollOffset(document.getElementById("m"))).toBe(false);
    expect(document.getElementById("mp").style.transform).toBe("");
    expect(applyScrollOffset(null)).toBe(false);
    expect(applyScrollOffset({ nodeType: 1 })).toBe(false);
  });

  it("copes with a target that cannot be queried", () => {
    expect(typeof markScrolled({})).toBe("function");
    expect(typeof markScrolled(null)).toBe("function");
  });
});
