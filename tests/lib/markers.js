// The marker catalogue: every position a page can hold a secret in, generated mechanically.
//
// Why this exists. The bespoke page copy this library used to send leaked sensitive data in three
// consecutive adversarial reviews — a `<template>`, then an `<iframe srcdoc>`, then a `<style>`'s
// raw text — and every one was found by a person imagining where a secret could hide, which is
// why there was always one more. This file replaces the imagining with enumeration: the positions
// are the product of dimension lists (zones x containers x attribute kinds x input types x value
// modes), so adding one entry to a list adds every combination of it, and a position nobody
// thought of is a missing list entry rather than a missing idea.
//
// A marker is a unique token planted in exactly one position. `tests/lib/capture-harness.js`
// plants them all into one page, runs the real capture path once per settings combination, and
// looks for every marker in every part of the outgoing FormData. A marker found somewhere it
// should not be names its own position, so a failure says *which* position leaked.
//
// Markers are `[A-Z0-9]` only, on purpose: HTML-escaping, JSON-escaping, percent-encoding,
// attribute-name lowercasing and rrweb's URL absolutisation all leave such a token byte-identical,
// so "did it reach the bundle" is a plain substring test that cannot produce a false negative.

export const MARKER_PREFIX = "FBHMK";

// Zones. Which zone a position sits in is what its expected fate is mostly decided by.
//
// - `ordinary`   ordinary page content. A session replay exists to reproduce the page, so text
//                and attributes here are published on purpose; input values are not, under
//                `maskAllInputs`.
// - `sensitive`  inside an element the app named in `capture.blank` (the CAD dashboard points it
//                at cost prices, margins and customer records). Nothing from here may be sent.
// - `blanked`    the blanked element *itself* carries the marker, rather than a descendant. This
//                is a different mechanism: rrweb keeps a blocked element as a placeholder node,
//                so what survives on the element itself is not what survives inside it.
// - `reporter`   what the reporter typed, chose or is looking at — their own words, the section
//                name, the page title. These must arrive: a report without them is useless.
export const ZONES = ["ordinary", "sensitive", "blanked", "reporter"];

export const BLANK_CLASS = "fbh-blank";
export const BLANK_SELECTOR = `.${BLANK_CLASS}`;

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const CUSTOM_NS = "urn:x-amikob-cost";

// ---------------------------------------------------------------------------------------------
// Minting

export function createMinter(nonce) {
  let seq = 0;
  const used = new Set();
  return function mint(id) {
    seq += 1;
    const slug = id
      .replace(/[^a-z0-9]/gi, "")
      .toUpperCase()
      .slice(0, 28);
    const marker = `${MARKER_PREFIX}${nonce}X${String(seq).padStart(3, "0")}X${slug}`;
    if (used.has(marker)) throw new Error(`duplicate marker for position "${id}"`);
    used.add(marker);
    return marker;
  };
}

export function randomNonce() {
  return Math.random()
    .toString(36)
    .slice(2, 8)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "Q");
}

// ---------------------------------------------------------------------------------------------
// Dimension lists. Everything below is generated from these; nothing is written out by hand.

// Attribute kinds. `kind` drives the fate rule, `on` picks a host element that the attribute is
// plausible on, and `set` is how it goes onto that element (some are namespaced, which is the
// case a `querySelectorAll`-shaped sanitiser misses and a serialiser does not).
const ATTRIBUTES = [
  { id: "title", on: "div", set: (el, v) => el.setAttribute("title", v) },
  { id: "alt", on: "img", set: (el, v) => el.setAttribute("alt", v) },
  { id: "data-attr", on: "div", set: (el, v) => el.setAttribute("data-cost", v) },
  { id: "href", on: "a", set: (el, v) => el.setAttribute("href", `/export/${v}`) },
  { id: "href-query", on: "a", set: (el, v) => el.setAttribute("href", `/export?token=${v}`) },
  { id: "src", on: "img", set: (el, v) => el.setAttribute("src", `/img/${v}.png`) },
  { id: "value-attr", on: "input", set: (el, v) => el.setAttribute("value", v) },
  { id: "placeholder", on: "input", set: (el, v) => el.setAttribute("placeholder", v) },
  { id: "aria-label", on: "div", set: (el, v) => el.setAttribute("aria-label", v) },
  { id: "class", on: "div", set: (el, v) => el.classList.add(`cost-${v}`) },
  { id: "id", on: "div", set: (el, v) => el.setAttribute("id", `row-${v}`) },
  { id: "style-custom-prop", on: "div", set: (el, v) => el.setAttribute("style", `--cost:'${v}'`) },
  { id: "srcdoc", on: "iframe", set: (el, v) => el.setAttribute("srcdoc", `<p>${v}</p>`) },
  { id: "script-data", on: "script", set: (el, v) => el.setAttribute("data-page-state", v) },
  { id: "meta-content", on: "meta", set: (el, v) => el.setAttribute("content", v) },
  {
    id: "meta-csrf",
    on: "meta",
    set: (el, v) => {
      el.setAttribute("name", "csrf-token");
      el.setAttribute("content", v);
    },
  },
  { id: "option-value", on: "select", set: (el, v) => el.appendChild(option(el, v, "pick")) },
  { id: "option-text", on: "select", set: (el, v) => el.appendChild(option(el, "x", v)) },
  // Namespaced attributes: the qualified name is what a serialiser prints and what a
  // `[name=...]` selector cannot reach.
  {
    id: "ns-xlink-href",
    on: "svg-a",
    set: (el, v) => el.setAttributeNS(XLINK_NS, "xlink:href", `/x/${v}`),
  },
  { id: "ns-xml-lang", on: "div", set: (el, v) => el.setAttributeNS(XML_NS, "xml:lang", v) },
  { id: "ns-custom", on: "div", set: (el, v) => el.setAttributeNS(CUSTOM_NS, "amk:cost", v) },
  { id: "ns-svg-datacost", on: "svg-rect", set: (el, v) => el.setAttribute("data-cost", v) },
  { id: "ns-math-href", on: "math-mi", set: (el, v) => el.setAttribute("href", `/m/${v}`) },
];

function option(select, value, text) {
  const doc = select.ownerDocument;
  const opt = doc.createElement("option");
  opt.setAttribute("value", value);
  opt.textContent = text;
  return opt;
}

// Every input type in the HTML spec, plus the two other field elements. `hidden` and `file` are
// the two the review rounds kept coming back to: a hidden field routinely holds a token or a
// record id, and a file field's value is the file's name.
const INPUT_TYPES = [
  "text",
  "password",
  "hidden",
  "email",
  "number",
  "search",
  "tel",
  "url",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "color",
  "range",
  "checkbox",
  "radio",
  "file",
  "submit",
  "button",
  "reset",
  "image",
];

// Two ways a field can carry a value, which is the case where the DOM and the HTML disagree: an
// attribute a serialiser sees by cloning, and a property only a live read finds.
const VALUE_MODES = ["attribute", "property"];

// Containers: the node sets a walk over `querySelectorAll` and a walk over the serialiser see
// differently. Each opens a parent to plant into and says which payloads make sense there.
const CONTAINERS = [
  { id: "plain", depth: 0, payloads: ["text", "attr", "password"], open: (doc, parent) => parent },
  {
    id: "template",
    depth: 1,
    payloads: ["text", "attr", "password"],
    open: (doc, parent) => {
      const t = doc.createElement("template");
      parent.appendChild(t);
      return t.content;
    },
  },
  {
    id: "template-deep",
    depth: 3,
    payloads: ["text", "attr", "password"],
    open: (doc, parent) => {
      let here = parent;
      for (let i = 0; i < 3; i += 1) {
        const t = doc.createElement("template");
        here.appendChild(t);
        here = t.content;
      }
      return here;
    },
  },
  {
    id: "shadow-open",
    depth: 1,
    payloads: ["text", "attr", "password"],
    open: (doc, parent) => {
      const host = doc.createElement("div");
      parent.appendChild(host);
      return host.attachShadow({ mode: "open" });
    },
  },
  {
    id: "shadow-closed",
    depth: 1,
    payloads: ["text", "attr", "password"],
    open: (doc, parent) => {
      const host = doc.createElement("div");
      parent.appendChild(host);
      return host.attachShadow({ mode: "closed" });
    },
  },
  {
    id: "svg",
    depth: 1,
    payloads: ["text", "attr"],
    element: (doc) => doc.createElementNS(SVG_NS, "text"),
    open: (doc, parent) => {
      const svg = doc.createElementNS(SVG_NS, "svg");
      parent.appendChild(svg);
      const g = doc.createElementNS(SVG_NS, "g");
      svg.appendChild(g);
      return g;
    },
  },
  {
    id: "mathml",
    depth: 1,
    payloads: ["text", "attr"],
    element: (doc) => doc.createElementNS(MATHML_NS, "mi"),
    open: (doc, parent) => {
      const math = doc.createElementNS(MATHML_NS, "math");
      parent.appendChild(math);
      const row = doc.createElementNS(MATHML_NS, "mrow");
      math.appendChild(row);
      return row;
    },
  },
  {
    id: "svg-foreignobject",
    depth: 2,
    payloads: ["text", "attr", "password"],
    open: (doc, parent) => {
      const svg = doc.createElementNS(SVG_NS, "svg");
      parent.appendChild(svg);
      const fo = doc.createElementNS(SVG_NS, "foreignObject");
      svg.appendChild(fo);
      const div = doc.createElement("div");
      fo.appendChild(div);
      return div;
    },
  },
];

// Raw-text elements: the parser puts their content into one text node, so a walk that looks for
// elements finds nothing inside them while a serialiser prints them back verbatim. `<noscript>`
// is the one jsdom cannot reproduce — with scripting disabled (jsdom's default, and vitest's) it
// parses noscript content as real elements, where a browser with scripting enabled makes it a
// single raw text node. The text node is therefore built by hand below, which is the browser's
// shape, so this case is exercised rather than skipped.
const RAW_TEXT = ["style", "noscript", "xmp", "textarea", "title", "listing", "plaintext"];

// The channels that are not page serialisation at all: our own buffers, which read text out of
// the page and out of the app's own calls. The breadcrumb describer reads labels, placeholders,
// aria-labels, data attributes and element text; the console buffer takes whatever the app
// logged; the network buffer takes URLs.
const CHANNELS = [
  { id: "click-text", kind: "breadcrumb" },
  { id: "click-aria", kind: "breadcrumb" },
  { id: "click-data", kind: "breadcrumb" },
  { id: "click-id", kind: "breadcrumb" },
  { id: "change-label", kind: "breadcrumb" },
  { id: "change-placeholder", kind: "breadcrumb" },
  { id: "change-aria", kind: "breadcrumb" },
  { id: "change-name", kind: "breadcrumb" },
  { id: "change-value", kind: "breadcrumb" },
  { id: "change-password", kind: "breadcrumb" },
  { id: "change-file-label", kind: "breadcrumb" },
  // The other direction. Everything above puts the blanked element *around* the one being
  // described, which is the direction `closest` walks; these put it *inside* it, which is the
  // direction `textContent` walks — a price in a span inside the clickable card, a blanked field
  // inside a submitted form, a `<label for=…>` inside a blanked region pointing at a field
  // outside it.
  { id: "click-text-nested", kind: "breadcrumb" },
  { id: "submit-text", kind: "breadcrumb" },
  { id: "submit-blanked", kind: "breadcrumb" },
  { id: "change-label-outside", kind: "breadcrumb" },
  // The error buffer, which is always on, cannot be switched off, and puts a message and a stack
  // straight into the report JSON. It had no channel at all (audit finding F5).
  { id: "error-message", kind: "error" },
  { id: "error-stack", kind: "error" },
  { id: "console-arg", kind: "console" },
  { id: "network-path", kind: "network" },
  { id: "network-query", kind: "network" },
  { id: "route-hash", kind: "breadcrumb" },
  { id: "route-hash-params", kind: "breadcrumb" },
  { id: "route-query", kind: "breadcrumb" },
  { id: "location-query", kind: "page" },
  { id: "location-hash-params", kind: "page" },
  { id: "document-title", kind: "page" },
  { id: "image-bytes", kind: "attachment" },
  { id: "screenshot-bytes", kind: "attachment" },
  { id: "reporter-text", kind: "report" },
  { id: "reporter-name", kind: "report" },
  { id: "section-name", kind: "report" },
];

// ---------------------------------------------------------------------------------------------
// Generation

// `kind` is what the fate rule keys on. Everything else is description.
function position(fields) {
  return { gap: false, mechanism: null, ...fields };
}

function attributePositions() {
  const out = [];
  for (const zone of ["ordinary", "sensitive", "blanked"]) {
    for (const attr of ATTRIBUTES) {
      out.push(
        position({
          id: `attr/${attr.id}/${zone}`,
          group: "attributes",
          zone,
          kind: attr.id === "value-attr" ? "input-value" : "attribute",
          where: `the ${attr.id} attribute of a <${attr.on}> ${placeOf(zone)}`,
          plant: (ctx) => {
            const el = hostElement(ctx.doc, attr.on);
            attr.set(el, ctx.marker);
            ctx.parent.appendChild(el);
          },
        }),
      );
    }
  }
  return out;
}

function hostElement(doc, name) {
  if (name === "svg-a") {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.appendChild(doc.createElementNS(SVG_NS, "a"));
    return svg.firstChild;
  }
  if (name === "svg-rect") {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.appendChild(doc.createElementNS(SVG_NS, "rect"));
    return svg.firstChild;
  }
  if (name === "math-mi") {
    const math = doc.createElementNS(MATHML_NS, "math");
    math.appendChild(doc.createElementNS(MATHML_NS, "mi"));
    return math.firstChild;
  }
  return doc.createElement(name);
}

// A value attribute is only a *typed* value for the kinds a person types into. A checkbox's or
// radio's value attribute is the option's key, and a button's is its visible label: both are
// markup that a recording reproduces like any other attribute, and neither is what maskAllInputs
// is about.
const MARKUP_VALUE_TYPES = new Set(["checkbox", "radio", "submit", "button", "reset", "image"]);

// `hidden` and `file` are masked whatever the app asked for (src/capture/replay.js), so they are
// their own kind rather than ordinary field values: no setting publishes them.
const ALWAYS_MASKED_TYPES = new Set(["hidden", "file"]);

function inputKind(type) {
  if (type === "password") return "password";
  if (ALWAYS_MASKED_TYPES.has(type)) return "always-masked";
  return MARKUP_VALUE_TYPES.has(type) ? "attribute" : "input-value";
}

function inputPositions() {
  const out = [];
  for (const zone of ["ordinary", "sensitive", "blanked"]) {
    for (const type of INPUT_TYPES) {
      for (const mode of VALUE_MODES) {
        out.push(
          position({
            id: `input/${type}/${mode}/${zone}`,
            group: "inputs",
            zone,
            kind: inputKind(type),
            where: `an <input type="${type}"> whose value is set by ${mode} ${placeOf(zone)}`,
            plant: (ctx) => {
              const el = ctx.doc.createElement("input");
              el.setAttribute("type", type);
              el.setAttribute("name", `f-${type}-${mode}`);
              if (type === "checkbox" || type === "radio") {
                // A checkbox has no value worth typing into; the state is the secret. The value
                // attribute carries the marker so "which option was chosen" is testable at all.
                el.setAttribute("value", ctx.marker);
                if (mode === "attribute") el.setAttribute("checked", "");
                else el.checked = true;
              } else if (mode === "attribute") {
                el.setAttribute("value", ctx.marker);
              } else if (type === "file") {
                // A file input's value cannot be assigned — the browser refuses, and so does
                // jsdom. What a browser *does* expose after the reporter picks a file is a fake
                // path that still names the file ("C:\fakepath\design.stl"), and that is what a
                // recorder reads. jsdom has no way to reach that state, so the property is
                // defined on this one element to reproduce the shape a browser hands out.
                Object.defineProperty(el, "value", {
                  configurable: true,
                  get: () => `C:\\fakepath\\${ctx.marker}.stl`,
                });
              } else {
                el.value = ctx.marker;
              }
              ctx.parent.appendChild(el);
            },
          }),
        );
      }
    }
    for (const mode of VALUE_MODES) {
      out.push(
        position({
          id: `textarea/${mode}/${zone}`,
          group: "inputs",
          zone,
          kind: "input-value",
          where: `a <textarea> whose value is set by ${mode} ${placeOf(zone)}`,
          plant: (ctx) => {
            const el = ctx.doc.createElement("textarea");
            // "attribute" for a textarea means its raw text content, which is also its default
            // value: the two really are one thing in HTML, and that is the point of the case.
            if (mode === "attribute") el.appendChild(ctx.doc.createTextNode(ctx.marker));
            else el.value = ctx.marker;
            ctx.parent.appendChild(el);
          },
        }),
      );
      out.push(
        position({
          id: `select/${mode}/${zone}`,
          group: "inputs",
          zone,
          // The marker can only live on an <option>, and an option list is markup: what
          // maskAllInputs decides for a <select> is which option is marked selected, not whether
          // the choices themselves are recorded.
          kind: "attribute",
          where: `a <select> whose chosen option is set by ${mode} ${placeOf(zone)}`,
          plant: (ctx) => {
            const el = ctx.doc.createElement("select");
            const first = ctx.doc.createElement("option");
            first.setAttribute("value", "other");
            first.textContent = "other";
            const second = ctx.doc.createElement("option");
            second.setAttribute("value", ctx.marker);
            second.textContent = "chosen";
            el.append(first, second);
            if (mode === "attribute") second.setAttribute("selected", "");
            else el.selectedIndex = 1;
            ctx.parent.appendChild(el);
          },
        }),
      );
    }
    out.push(
      position({
        id: `input-cleared/${zone}`,
        group: "inputs",
        zone,
        kind: "input-value",
        where: `a field whose server-rendered value= attribute is still there after script cleared its live value ${placeOf(zone)}`,
        plant: (ctx) => {
          const el = ctx.doc.createElement("input");
          el.setAttribute("type", "text");
          el.setAttribute("name", "cleared");
          el.setAttribute("value", ctx.marker);
          // The ordinary shape of a server-rendered form a script has reset: the attribute keeps
          // what the server put there, the live value is empty. A recorder that decides whether
          // to mask by looking at the live value has nothing to mask and publishes the attribute.
          el.value = "";
          ctx.parent.appendChild(el);
        },
      }),
    );
    out.push(
      position({
        id: `input-cleared-password/${zone}`,
        group: "inputs",
        zone,
        kind: "password",
        where: `a password field whose server-rendered value= attribute is still there after script cleared its live value ${placeOf(zone)}`,
        plant: (ctx) => {
          // The same shape as `input-cleared`, on the one field kind no gap may ever excuse.
          // rrweb masks a field only when its live value is truthy and does not special-case a
          // password there, so "a password never leaves, under any settings" was a promise the
          // harness could not reach until this position existed (audit finding F3).
          const el = ctx.doc.createElement("input");
          el.setAttribute("type", "password");
          el.setAttribute("name", "cleared-pw");
          el.setAttribute("value", ctx.marker);
          el.value = "";
          ctx.parent.appendChild(el);
        },
      }),
    );
    out.push(
      position({
        id: `contenteditable/${zone}`,
        group: "inputs",
        zone,
        kind: "editable-text",
        where: `text typed into a contenteditable div ${placeOf(zone)}`,
        plant: (ctx) => {
          const el = ctx.doc.createElement("div");
          el.setAttribute("contenteditable", "true");
          el.textContent = ctx.marker;
          ctx.parent.appendChild(el);
        },
      }),
    );
  }
  return out;
}

function containerPositions() {
  const out = [];
  for (const zone of ["ordinary", "sensitive"]) {
    for (const container of CONTAINERS) {
      for (const payload of container.payloads) {
        out.push(
          position({
            id: `in/${container.id}/${payload}/${zone}`,
            group: "containers",
            zone,
            kind: payload === "password" ? "password" : payload === "attr" ? "attribute" : "text",
            where: `${payload} inside ${container.id}${container.depth > 1 ? ` (${container.depth} deep)` : ""} ${placeOf(zone)}`,
            plant: (ctx) => {
              const parent = container.open(ctx.doc, ctx.parent);
              if (payload === "password") {
                const el = ctx.doc.createElement("input");
                el.setAttribute("type", "password");
                el.setAttribute("value", ctx.marker);
                parent.appendChild(el);
                return;
              }
              const el = container.element
                ? container.element(ctx.doc)
                : ctx.doc.createElement("div");
              if (payload === "text") el.textContent = ctx.marker;
              else el.setAttribute("title", ctx.marker);
              parent.appendChild(el);
            },
          }),
        );
      }
    }
  }
  return out;
}

function rawTextPositions() {
  const out = [];
  for (const zone of ["ordinary", "sensitive"]) {
    for (const tag of RAW_TEXT) {
      out.push(
        position({
          id: `rawtext/${tag}/${zone}`,
          group: "raw-text",
          zone,
          kind: tag === "textarea" ? "input-value" : "text",
          where: `the raw text of a <${tag}> ${placeOf(zone)}`,
          plant: (ctx) => {
            const el = ctx.doc.createElement(tag);
            // Built as one text node on purpose. A browser's tokenizer produces exactly this for
            // every element in this list; jsdom's parser only agrees for some of them (notably it
            // parses <noscript> content as elements, because vitest's jsdom has scripting off),
            // so constructing the node directly is what makes the browser's shape testable here.
            el.appendChild(ctx.doc.createTextNode(tagPayload(tag, ctx.marker)));
            ctx.parent.appendChild(el);
          },
        }),
      );
    }
    out.push(
      position({
        id: `style-declaration/${zone}`,
        group: "raw-text",
        zone,
        kind: "text",
        where: `a CSS declaration value in a <style> ${placeOf(zone)}`,
        plant: (ctx) => {
          const el = ctx.doc.createElement("style");
          el.appendChild(
            ctx.doc.createTextNode(`.c-${ctx.marker}::after{content:"${ctx.marker}"}`),
          );
          ctx.parent.appendChild(el);
        },
      }),
    );
    out.push(
      position({
        id: `comment/${zone}`,
        group: "raw-text",
        zone,
        kind: "comment",
        where: `an HTML comment ${placeOf(zone)}`,
        plant: (ctx) => ctx.parent.appendChild(ctx.doc.createComment(` session=${ctx.marker} `)),
      }),
    );
    out.push(
      position({
        id: `script-text/${zone}`,
        group: "raw-text",
        zone,
        kind: "text",
        where: `the source text of an inline <script> ${placeOf(zone)}`,
        plant: (ctx) => {
          const el = ctx.doc.createElement("script");
          el.setAttribute("type", "application/json");
          el.appendChild(ctx.doc.createTextNode(`{"cost":"${ctx.marker}"}`));
          ctx.parent.appendChild(el);
        },
      }),
    );
  }
  return out;
}

function tagPayload(tag, marker) {
  if (tag === "style") return `.x{color:red}/* ${marker} */`;
  return marker;
}

function channelPositions() {
  return CHANNELS.map((channel) =>
    position({
      id: `channel/${channel.id}`,
      group: "channels",
      zone:
        channel.id.startsWith("reporter") || channel.id === "section-name" ? "reporter" : "channel",
      kind: `channel-${channel.kind}`,
      channel: channel.id,
      where: `the ${channel.id.replace(/-/g, " ")} channel`,
      plant: null, // planted by the harness, which owns the interactions that feed the buffers
    }),
  );
}

function placeOf(zone) {
  if (zone === "sensitive") return `inside a blanked element`;
  if (zone === "blanked") return `on the blanked element itself`;
  return "in ordinary page content";
}

// Positions planted a second time, after the library has mounted and the recorder has taken its
// full snapshot. Everything else in this file is planted before mount, so rrweb's *mutation* path
// — `processMutation`, and `serializeNodeWithId` with `skipChild: true, newlyAddedElement: true`,
// with its own masking and its own `isBlocked(..., checkAncestors=false)` — was never exercised.
// For a dashboard that renders its views after load, that path carries most of the recording
// (audit finding F6).
//
// The subset is chosen to cover both answers: the withheld ones prove the masking and blocking
// hold on that path, and the published ones prove the path is recording at all — without them a
// mutation path that had quietly stopped working would read as a clean result.
export const MUTATION_SUBSET = [
  "in/plain/text/ordinary",
  "in/plain/text/sensitive",
  "attr/title/ordinary",
  "attr/title/sensitive",
  "attr/class/blanked",
  "attr/srcdoc/ordinary",
  "attr/href-query/ordinary",
  "input/text/property/ordinary",
  "input/password/attribute/ordinary",
  "input/password/property/ordinary",
  "input/hidden/property/ordinary",
  "input/file/property/ordinary",
  "input-cleared/ordinary",
  "input-cleared-password/ordinary",
  "contenteditable/sensitive",
];

export function mutationPositions(positions) {
  const by = new Map(positions.map((one) => [one.id, one]));
  const out = [];
  for (const id of MUTATION_SUBSET) {
    const position = by.get(id);
    // A caller can pass a short list of its own (the self-test does), and then there is nothing
    // here to re-plant. A typo in the list above is caught by the count assertion in
    // tests/leak-matrix.test.js, not silently dropped.
    if (position)
      out.push({
        ...position,
        phase: "after mount",
        where: `${position.where}, added after mount`,
      });
  }
  return out;
}

// The automatic screenshot, which `capture.screenshot` leaves **on** by default and which the
// first harness switched off in all six combinations, substituting a PNG it had built itself. It
// is the highest-fidelity copy of the page the library sends, so it gets positions of its own and
// a run of its own (tests/leak-matrix.test.js, "the automatic screenshot").
//
// Why a separate, curated set rather than the whole catalogue: jsdom cannot rasterise, so that run
// scans the cloned, style-inlined SVG that modern-screenshot draws the picture from. The clone
// carries things the picture never shows — every attribute, a `<title>` in the body, a hidden
// field's value — so scanning the whole catalogue against it would assert fates that a raster
// cannot break. A position belongs here only when a browser would really paint it.
export function screenshotPositions() {
  const paintedText = (ctx) => {
    const el = ctx.doc.createElement("p");
    el.textContent = `Cost ${ctx.marker}`;
    ctx.parent.appendChild(el);
  };
  const typedValue = (type) => (ctx) => {
    const el = ctx.doc.createElement("input");
    el.setAttribute("type", type);
    // The live value, which is what modern-screenshot copies onto the clone and what a browser
    // paints into the field.
    el.value = ctx.marker;
    ctx.parent.appendChild(el);
  };
  return [
    position({
      id: "screenshot/text/ordinary",
      group: "screenshot",
      zone: "ordinary",
      kind: "text",
      where: "text a browser paints, in ordinary page content",
      plant: paintedText,
    }),
    position({
      id: "screenshot/text/sensitive",
      group: "screenshot",
      zone: "sensitive",
      kind: "text",
      where: "text a browser paints, inside a blanked element",
      plant: paintedText,
    }),
    position({
      id: "screenshot/text/blanked",
      group: "screenshot",
      zone: "blanked",
      kind: "text",
      where: "text a browser paints, on the blanked element itself",
      plant: paintedText,
    }),
    position({
      id: "screenshot/field-value/sensitive",
      group: "screenshot",
      zone: "sensitive",
      kind: "input-value",
      where: "a field's typed value, inside a blanked element",
      plant: typedValue("text"),
    }),
    position({
      id: "screenshot/field-value/ordinary",
      group: "screenshot",
      zone: "ordinary",
      kind: "input-value",
      where: "a field's typed value, in ordinary page content",
      plant: typedValue("text"),
    }),
    position({
      id: "screenshot/password/ordinary",
      group: "screenshot",
      zone: "ordinary",
      kind: "password",
      where: "a password field's value, in ordinary page content",
      plant: typedValue("password"),
    }),
    // The other kinds of field a browser paints a value into, each masked by the recording under
    // maskAllInputs and, since 2026-09-22, by the picture as well.
    position({
      id: "screenshot/textarea/ordinary",
      group: "screenshot",
      zone: "ordinary",
      kind: "input-value",
      where: "a textarea's text, in ordinary page content",
      plant: (ctx) => {
        // Child text, the server-rendered shape and what a browser paints: a `value` attribute
        // on a textarea paints nothing, so a position planted that way would be satisfied by
        // markup the picture never shows.
        const el = ctx.doc.createElement("textarea");
        el.appendChild(ctx.doc.createTextNode(ctx.marker));
        // A decoy live value: modern-screenshot copies the live value onto the clone as a
        // `value` attribute (unpainted), so with the marker only in the child text a control run
        // is satisfied by what the picture paints and by nothing else.
        el.value = "not the marker";
        ctx.parent.appendChild(el);
      },
    }),
    position({
      id: "screenshot/select/ordinary",
      group: "screenshot",
      zone: "ordinary",
      kind: "input-value",
      where: "a select's chosen option, in ordinary page content",
      // The picture only: the recording keeps a select's option list as page content and masks
      // the select's value alone (fates.js says why), so this claim is about what is painted.
      parts: ["screenshot"],
      plant: (ctx) => {
        // Two options, the marker only on the chosen one's text — what a browser paints — and
        // not on the select's own `value`, which paints nothing.
        const el = ctx.doc.createElement("select");
        const other = ctx.doc.createElement("option");
        other.value = "other";
        other.textContent = "Other";
        const chosen = ctx.doc.createElement("option");
        chosen.value = "chosen";
        chosen.textContent = ctx.marker;
        el.appendChild(other);
        el.appendChild(chosen);
        el.value = "chosen";
        ctx.parent.appendChild(el);
      },
    }),
    position({
      id: "screenshot/editable/ordinary",
      group: "screenshot",
      zone: "ordinary",
      kind: "editable-text",
      where: "text typed into a contenteditable region, in ordinary page content",
      plant: (ctx) => {
        const el = ctx.doc.createElement("div");
        el.setAttribute("contenteditable", "true");
        el.textContent = ctx.marker;
        ctx.parent.appendChild(el);
      },
    }),
  ];
}

export function buildPositions() {
  return [
    ...attributePositions(),
    ...inputPositions(),
    ...containerPositions(),
    ...rawTextPositions(),
    ...channelPositions(),
  ];
}
