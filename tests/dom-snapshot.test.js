/** @vitest-environment jsdom */
import { JSDOM } from "jsdom";
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

  // --- Review 5, F1: <template> content is invisible to querySelectorAll but is serialized ---
  // (review-5.md, findings section + "Did I get anything sensitive through?"). The reviewer's own
  // reproduction: a <script> and a password value planted inside a <template> both survived
  // byte-for-byte in the standalone jsdom script they wrote to demonstrate it.

  it("removes a <script> that lives inside a <template>", () => {
    document.body.innerHTML = `<template id="t"><script>window.x = 1;</script></template>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("window.x = 1");
  });

  it("blanks a password value planted inside a <template>", () => {
    document.body.innerHTML = `<template id="t"><input type="password" value="hunter2-in-template"></template>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("hunter2-in-template");
  });

  it("empties a blank-selector match that lives inside a <template>", () => {
    document.body.innerHTML = `<template id="t"><div class="sku-price">£4,200</div></template>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("4,200");
  });

  it("sanitizes a <template> nested three deep inside other templates", () => {
    document.body.innerHTML = `
      <template id="outer">
        <template id="middle">
          <template id="inner">
            <script>window.deep = 1;</script>
            <input type="password" value="deep-secret">
          </template>
        </template>
      </template>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("window.deep = 1");
    expect(html).not.toContain("deep-secret");
  });

  it("never leaks a <template> planted inside an open shadow root's markup", () => {
    // Shadow-root content is never serialized at all (existing behaviour, unrelated to the
    // <template> fix), so a <template> placed inside one must stay invisible regardless of what
    // is inside it.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<template><input type="password" value="shadow-template-secret"></template>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("shadow-template-secret");
  });

  it("still blanks a template's content when the template itself sits under a blank-matched ancestor", () => {
    document.body.innerHTML = `
      <div class="sku-price"><template><input type="text" value="ancestor-blanked"></template></div>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("ancestor-blanked");
  });

  it("blanks a <template>'s content when the blank selector matches the template itself", () => {
    document.body.innerHTML = `<template class="sku-price"><input type="text" value="direct-hit"></template>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("direct-hit");
  });

  // --- Review 5, F2: checkboxes/radios ignore maskAllInputs ---

  it("does not reveal a checked checkbox's state under maskAllInputs", () => {
    document.body.innerHTML = `<input id="c" type="checkbox">`;
    document.getElementById("c").checked = true;
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).not.toContain("checked");
  });

  it("does not reveal a checked radio's state under maskAllInputs", () => {
    document.body.innerHTML = `<input id="r" type="radio" name="g">`;
    document.getElementById("r").checked = true;
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).not.toContain("checked");
  });

  it("still stamps a checked checkbox's state when maskAllInputs is not set", () => {
    // Guards against the fix over-correcting: unmasked behaviour must keep working.
    document.body.innerHTML = `<input id="c" type="checkbox">`;
    document.getElementById("c").checked = true;
    const html = snapshotDom(document, {});
    expect(html).toContain("checked");
  });

  // --- Review 5, F3: contenteditable is not in FIELDS ---

  it("blanks a contenteditable element's typed content under maskAllInputs", () => {
    document.body.innerHTML = `<div id="e" contenteditable="true">a secret note</div>`;
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).not.toContain("a secret note");
  });

  it("blanks a contenteditable element with a bare contenteditable attribute under maskAllInputs", () => {
    document.body.innerHTML = `<div id="e" contenteditable>a bare secret</div>`;
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).not.toContain("a bare secret");
  });

  it("leaves contenteditable content alone when maskAllInputs is not set", () => {
    document.body.innerHTML = `<div id="e" contenteditable="true">kept note</div>`;
    const html = snapshotDom(document, {});
    expect(html).toContain("kept note");
  });

  it("does not touch an element whose contenteditable is explicitly false", () => {
    document.body.innerHTML = `<div id="e" contenteditable="false">not editable</div>`;
    const html = snapshotDom(document, { maskAllInputs: true });
    expect(html).toContain("not editable");
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

// --- Re-review 5: blanking is an allowlist, not a list of special cases ---------------------
// A blanked element keeps its tag name, its class and its id and nothing else. The valuable
// things on a dashboard live in attributes — a `title` carrying a cost price, a `data-margin`,
// an `img alt` naming a customer, an `href` carrying a token — and the previous round left every
// one of them in place under a `data-fbh-blanked=""` stamp that claimed the opposite.

describe("blanking", () => {
  it("strips title and data-* from a blanked element but keeps class and id", () => {
    document.body.innerHTML = `<div id="p1" class="sku-price" title="Cost GBP 1,240" data-margin="238%">GBP 4,200</div>`;
    const html = snapshotDom(document, { blank: [".sku-price"] });
    expect(html).not.toContain("1,240");
    expect(html).not.toContain("238%");
    expect(html).not.toContain("4,200");
    expect(html).toContain('class="sku-price"');
    expect(html).toContain('id="p1"');
    expect(html).toContain(BLANKED_ATTR);
  });

  it("strips alt and src from a blanked <img>", () => {
    document.body.innerHTML = `<img class="customer-photo" alt="Ada Lovelace, 12 Bank St" src="data:image/png;base64,CUSTOMERFACEBYTES">`;
    const html = snapshotDom(document, { blank: [".customer-photo"] });
    expect(html).not.toContain("Ada Lovelace");
    expect(html).not.toContain("CUSTOMERFACEBYTES");
  });

  it("strips href from a blanked <a>", () => {
    document.body.innerHTML = `<a class="export-link" href="/api/export?token=sbp_live_9f3ac">export</a>`;
    expect(snapshotDom(document, { blank: [".export-link"] })).not.toContain("sbp_live_9f3ac");
  });

  it("strips placeholder, name and data-* from a blanked <input>", () => {
    document.body.innerHTML = `<input class="cust-field" placeholder="ada@example.com" name="customer_email" data-customer-id="C-3391">`;
    const html = snapshotDom(document, { blank: [".cust-field"] });
    expect(html).not.toContain("ada@example.com");
    expect(html).not.toContain("customer_email");
    expect(html).not.toContain("C-3391");
  });

  it("strips poster from a blanked <video>", () => {
    document.body.innerHTML = `<video class="clip" poster="data:image/png;base64,POSTERBYTES"></video>`;
    expect(snapshotDom(document, { blank: [".clip"] })).not.toContain("POSTERBYTES");
  });

  it("blanks a <meta>, whose `content` IDL property is a string and not a template's", () => {
    document.head.innerHTML = `<meta class="m" name="csrf-token" content="META_CONTENT_MARK">`;
    const html = snapshotDom(document, { blank: [".m"] });
    expect(html).not.toContain("META_CONTENT_MARK");
    expect(html).not.toContain("csrf-token");
    expect(html).toContain(BLANKED_ATTR);
  });

  it("still removes the whole subtree of a blanked container", () => {
    document.body.innerHTML = `<div class="card"><span title="inner secret">deep</span></div>`;
    const html = snapshotDom(document, { blank: [".card"] });
    expect(html).not.toContain("inner secret");
    expect(html).not.toContain("<span");
  });
});

// --- Re-review 5: the snapshot must be inert by construction --------------------------------

describe("inert snapshot", () => {
  it("removes every on* handler attribute, the root element included", () => {
    document.documentElement.setAttribute("onload", "ROOT_HANDLER()");
    document.body.setAttribute("onunload", "BODY_HANDLER()");
    document.body.innerHTML = `<img src="x.png" onerror="IMG_HANDLER()"><div onclick="DIV_HANDLER()">t</div>`;
    try {
      const html = snapshotDom(document, {});
      expect(html).not.toContain("ROOT_HANDLER");
      expect(html).not.toContain("BODY_HANDLER");
      expect(html).not.toContain("IMG_HANDLER");
      expect(html).not.toContain("DIV_HANDLER");
      expect(html).not.toContain("onerror");
    } finally {
      document.documentElement.removeAttribute("onload");
      document.body.removeAttribute("onunload");
    }
  });

  it("removes a case-preserved handler attribute in a foreign namespace", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    // setAttribute lowercases only for HTML elements: on an SVG element the name keeps its case,
    // is serialized as `ONLOAD=` and fires when the snapshot is opened.
    svg.setAttribute("ONLOAD", "SVG_HANDLER()");
    document.body.appendChild(svg);
    expect(snapshotDom(document, {})).not.toContain("SVG_HANDLER");
  });

  it("neutralises javascript: URLs in href, src, action, formaction and xlink:href", () => {
    document.body.innerHTML = `
      <a href="javascript:JS_HREF()">a</a>
      <img src="javascript:JS_SRC()">
      <form action="javascript:JS_ACTION()"><button formaction="javascript:JS_FORMACTION()"></button></form>
      <svg><a xlink:href="javascript:JS_XLINK()"></a></svg>`;
    const html = snapshotDom(document, {});
    for (const mark of ["JS_HREF", "JS_SRC", "JS_ACTION", "JS_FORMACTION", "JS_XLINK"]) {
      expect(html).not.toContain(mark);
    }
    expect(html).not.toContain("javascript:");
  });

  it("neutralises a javascript: URL split by a tab, the way the URL parser reads it", () => {
    document.body.innerHTML = `<a id="t">a</a>`;
    document.getElementById("t").setAttribute("href", "java\tscript:JS_TAB()");
    expect(snapshotDom(document, {})).not.toContain("JS_TAB");
  });

  it("removes a data: document URL from an <iframe> but keeps a data: image", () => {
    document.body.innerHTML = `
      <iframe src="data:text/html,%3Csvg onload=DATA_DOC()%3E"></iframe>
      <img src="data:image/png;base64,KEPTIMAGEBYTES">`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("DATA_DOC");
    expect(html).toContain("KEPTIMAGEBYTES");
  });

  it("removes srcdoc wherever it appears, including inside a <template>", () => {
    document.body.innerHTML = `
      <iframe srcdoc="<p>INVOICE_MARK</p><script>SRCDOC_SCRIPT_MARK</script><input type=password value=srcdoc-password-mark>"></iframe>
      <template><iframe srcdoc="<p>TEMPLATE_SRCDOC_MARK</p>"></iframe></template>`;
    const html = snapshotDom(document, { maskAllInputs: true, blank: [".sku-price"] });
    expect(html).not.toContain("INVOICE_MARK");
    expect(html).not.toContain("SRCDOC_SCRIPT_MARK");
    expect(html).not.toContain("srcdoc-password-mark");
    expect(html).not.toContain("TEMPLATE_SRCDOC_MARK");
    expect(html).not.toContain("srcdoc");
  });

  it("removes a meta refresh's content so the snapshot does not navigate away", () => {
    document.head.innerHTML = `<meta http-equiv="refresh" content="0;url=https://evil.example/META_REFRESH_MARK">`;
    expect(snapshotDom(document, {})).not.toContain("META_REFRESH_MARK");
  });

  it("removes an uppercase script built with createElementNS, which querySelectorAll misses", () => {
    // `createElementNS` keeps the case it is given, so the element's local name is "SCRIPT":
    // querySelectorAll("script") does not match it, `.outerHTML` prints `<SCRIPT>`, and the HTML
    // parser that reads the snapshot back matches tag names case-insensitively and runs it.
    for (const ns of ["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"]) {
      document.body.innerHTML = "";
      const script = document.createElementNS(ns, "SCRIPT");
      script.textContent = "UPPERCASE_SCRIPT_MARK";
      document.body.appendChild(script);
      expect(snapshotDom(document, {})).not.toContain("UPPERCASE_SCRIPT_MARK");
    }
  });

  it("keeps <style> so the snapshot still looks like the page", () => {
    document.head.innerHTML = `<style>.sku-price { color: rebeccapurple }</style>`;
    expect(snapshotDom(document, {})).toContain("rebeccapurple");
  });
});

// --- Re-review 5: content that hides where querySelectorAll cannot look ----------------------

describe("hidden content", () => {
  it("clears a <noscript> whose children are one raw text node", () => {
    // What every scripting-enabled browser produces: the tokenizer puts <noscript> content into
    // RAWTEXT, so it is a single Text node with no elements in it, invisible to querySelectorAll
    // and printed straight back out by the serializer. jsdom only parses it that way with
    // runScripts: "dangerously", so the node shape is built here by hand.
    const noscript = document.createElement("noscript");
    noscript.appendChild(
      document.createTextNode(
        `<script>NOSCRIPT_SCRIPT_MARK</script><input type="password" value="noscript-password-mark"><div class="sku-price">NOSCRIPT_PRICE_MARK</div>`,
      ),
    );
    document.body.appendChild(noscript);
    const html = snapshotDom(document, { maskAllInputs: true, blank: [".sku-price"] });
    expect(html).not.toContain("NOSCRIPT_SCRIPT_MARK");
    expect(html).not.toContain("noscript-password-mark");
    expect(html).not.toContain("NOSCRIPT_PRICE_MARK");
    expect(html).toContain("<noscript></noscript>");
  });

  it("clears a <noscript> parsed by a scripting-enabled, browser-accurate parser", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><noscript><b class="sku-price">NOSCRIPT_PARSED_MARK</b></noscript></body></html>`,
      { runScripts: "dangerously" },
    );
    const noscript = dom.window.document.querySelector("noscript");
    // Proof that this parse really is the raw-text one: one Text node, no element children.
    expect(noscript.childNodes.length).toBe(1);
    expect(noscript.childNodes[0].nodeType).toBe(3);
    expect(snapshotDom(dom.window.document, { blank: [".sku-price"] })).not.toContain(
      "NOSCRIPT_PARSED_MARK",
    );
  });

  it("clears an <iframe>'s raw-text fallback, which no selector can reach", () => {
    document.body.innerHTML = `<iframe><div class="sku-price">IFRAME_FALLBACK_MARK</div></iframe>`;
    const iframe = document.querySelector("iframe");
    expect(iframe.childNodes[0].nodeType).toBe(3); // raw text, not an element
    expect(snapshotDom(document, { blank: [".sku-price"] })).not.toContain("IFRAME_FALLBACK_MARK");
  });

  it("clears <noembed> and <noframes> raw text too", () => {
    document.body.innerHTML = `<noembed><b>NOEMBED_MARK</b></noembed><noframes><b>NOFRAMES_MARK</b></noframes>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("NOEMBED_MARK");
    expect(html).not.toContain("NOFRAMES_MARK");
  });

  it("removes comment nodes from the head, the body and a template's content", () => {
    document.head.innerHTML = `<!-- session=HEAD_COMMENT_MARK -->`;
    document.body.innerHTML = `<!-- user=BODY_COMMENT_MARK --><template><!-- TEMPLATE_COMMENT_MARK --></template>`;
    const html = snapshotDom(document, {});
    expect(html).not.toContain("HEAD_COMMENT_MARK");
    expect(html).not.toContain("BODY_COMMENT_MARK");
    expect(html).not.toContain("TEMPLATE_COMMENT_MARK");
  });
});

// --- Re-review 5: every pass must consider the root element itself ---------------------------

describe("the root element", () => {
  it("masks a contenteditable <html> under maskAllInputs", () => {
    document.documentElement.setAttribute("contenteditable", "true");
    document.body.innerHTML = `<p>ROOT_EDITABLE_MARK</p>`;
    try {
      expect(snapshotDom(document, { maskAllInputs: true })).not.toContain("ROOT_EDITABLE_MARK");
    } finally {
      document.documentElement.removeAttribute("contenteditable");
    }
  });

  it("blanks the root element when a blank selector names it", () => {
    document.body.innerHTML = `<p>ROOT_BLANK_MARK</p>`;
    const html = snapshotDom(document, { blank: ["html"] });
    expect(html).not.toContain("ROOT_BLANK_MARK");
    expect(html).toContain(BLANKED_ATTR);
  });

  it("masks a document made editable with designMode under maskAllInputs", () => {
    // jsdom implements no designMode at all, so the assignment below is a plain property — which
    // is exactly what the code reads, and what a browser reflects when designMode is switched on.
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = `<p>DESIGNMODE_MARK</p>`;
    doc.designMode = "on";
    expect(snapshotDom(doc, { maskAllInputs: true })).not.toContain("DESIGNMODE_MARK");
    expect(snapshotDom(doc, {})).toContain("DESIGNMODE_MARK");
  });
});

// --- Re-review 5: the templateRoots regression and the option guards -------------------------

describe("a <template> that is not an HTMLTemplateElement", () => {
  const cases = {
    "<svg><template>": `<svg><template><circle r="1"/></template></svg>`,
    "<math><template>": `<math><template><mi>x</mi></template></math>`,
  };
  for (const [name, markup] of Object.entries(cases)) {
    it(`still produces a snapshot for a page with ${name}`, () => {
      document.body.innerHTML = `${markup}<script>window.x = 1;</script><p>kept</p>`;
      const html = snapshotDom(document, { maskAllInputs: true, blank: [".sku-price"] });
      expect(html).toContain("kept");
      expect(html).not.toContain("window.x = 1");
    });
  }

  it("still produces a snapshot when one is created with createElementNS", () => {
    document.body.innerHTML = `<p>kept</p>`;
    document.body.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "template"));
    expect(snapshotDom(document, {})).toContain("kept");
  });

  it("does not throw out of the exported stampValues and blankElements", () => {
    document.body.innerHTML = `<svg><template></template></svg><input id="a"><div class="x">y</div>`;
    document.getElementById("a").value = "typed";
    const clone = document.documentElement.cloneNode(true);
    expect(() => stampValues(document.documentElement, clone, {})).not.toThrow();
    expect(() => blankElements(clone, [".x"])).not.toThrow();
    expect(clone.querySelector("#a").getAttribute("value")).toBe("typed");
  });
});

describe("option guards", () => {
  it("still produces a snapshot when blank is null rather than undefined", () => {
    document.body.innerHTML = `<p>NULL_BLANK_MARK</p>`;
    expect(snapshotDom(document, { blank: null })).toContain("NULL_BLANK_MARK");
  });

  it("still produces a snapshot when the options object itself is null", () => {
    document.body.innerHTML = `<p>NULL_OPTIONS_MARK</p>`;
    expect(snapshotDom(document, null)).toContain("NULL_OPTIONS_MARK");
  });

  it("takes a lone selector string as one selector rather than iterating its characters", () => {
    document.body.innerHTML = `<div class="sku-price">STRING_BLANK_MARK</div>`;
    expect(snapshotDom(document, { blank: ".sku-price" })).not.toContain("STRING_BLANK_MARK");
  });

  it("does not throw out of the exported functions when the root is not an element", () => {
    // stampValues and blankElements are exported, so they are called with whatever a caller has;
    // neither has a try/catch of its own, and neither needs one to survive a junk root.
    expect(() => blankElements(null, [".x"])).not.toThrow();
    expect(() => stampValues(null, null, {})).not.toThrow();
  });

  it("ignores a null selector list in the exported blankElements", () => {
    document.body.innerHTML = `<p>keep</p>`;
    const clone = document.documentElement.cloneNode(true);
    expect(() => blankElements(clone, null)).not.toThrow();
    expect(clone.outerHTML).toContain("keep");
  });
});

describe("the live document", () => {
  it("keeps its handlers, comments, srcdoc and blanked attributes after a snapshot", () => {
    document.body.innerHTML = `<!-- LIVE_COMMENT --><img class="ph" src="x.png" alt="LIVE_ALT" onerror="LIVE_HANDLER()"><iframe srcdoc="<p>LIVE_SRCDOC</p>"></iframe><noscript><b>LIVE_NOSCRIPT</b></noscript>`;
    snapshotDom(document, { maskAllInputs: true, blank: [".ph"] });
    const img = document.querySelector("img");
    expect(document.body.innerHTML).toContain("LIVE_COMMENT");
    expect(img.getAttribute("onerror")).toBe("LIVE_HANDLER()");
    expect(img.getAttribute("alt")).toBe("LIVE_ALT");
    expect(img.hasAttribute(BLANKED_ATTR)).toBe(false);
    expect(document.querySelector("iframe").getAttribute("srcdoc")).toContain("LIVE_SRCDOC");
    expect(document.querySelector("noscript").innerHTML).toContain("LIVE_NOSCRIPT");
  });
});

describe("pass order", () => {
  it("stamps typed values before anything is removed from the clone", () => {
    // stampValues pairs live and cloned fields by index. Sanitizing first would delete the
    // <noscript>'s field from the clone only, shifting every later pair by one, so the typed
    // value would be stamped onto a different element — or, as here, onto nothing at all.
    // Built by hand rather than parsed: whether <noscript> holds elements or one raw text node
    // depends on the parser's scripting flag, and this test is about the order of the passes, not
    // about which parse jsdom happened to use.
    const noscript = document.createElement("noscript");
    noscript.appendChild(document.createElement("input"));
    document.body.appendChild(noscript);
    const real = document.createElement("input");
    real.id = "real";
    document.body.appendChild(real);
    real.value = "TYPED_VALUE_MARK";
    const html = snapshotDom(document, {});
    expect(html).toContain('id="real" value="TYPED_VALUE_MARK"');
  });
});
