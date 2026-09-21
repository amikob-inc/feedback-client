// The harness: plant every marker, run the real capture path once, read the outgoing bundle back.
//
// "Real" is the load-bearing word. This mounts the library exactly as an app does — the same
// `mountFeedback`, the same buffers, the real `@rrweb/record`, the real bundle builder, the real
// gzip — and stubs only the transport, so what is inspected is the FormData that would have gone
// to the hub. Nothing here reimplements a capture step; a reimplementation would agree with itself
// and prove nothing.
//
// Everything runs under vitest's jsdom environment. Two things about that environment are worked
// around here and nowhere else:
//
//  - jsdom's Blob has no text()/arrayBuffer()/stream(), so the library's own real Blob usage
//    produces parts a test cannot read. `installBlobPolyfill` adds the three through the one
//    bridge vitest keeps working, URL.createObjectURL plus the real fetch. Same fix, same reason,
//    as tests/mount.test.js.
//  - jsdom parses <noscript> content as elements because it has scripting off, where a browser
//    makes it one raw text node. The raw-text positions build the text node directly, which is
//    the browser's shape (see tests/lib/markers.js).
import { gunzipSync } from "node:zlib";
import {
  BLANK_CLASS,
  BLANK_SELECTOR,
  buildPositions,
  createMinter,
  mutationPositions,
  randomNonce,
} from "./markers.js";
import { expectedFate } from "./fates.js";
import { mountFeedback } from "../../src/mount.js";
import { resetWarnings } from "../../src/warn.js";

export function installBlobPolyfill() {
  const proto = Blob.prototype;
  if (typeof proto.arrayBuffer === "function") return;
  proto.arrayBuffer = async function arrayBuffer() {
    const url = URL.createObjectURL(this);
    try {
      return await (await fetch(url)).arrayBuffer();
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  proto.text = async function text() {
    return new TextDecoder().decode(await this.arrayBuffer());
  };
  proto.stream = function stream() {
    const blob = this;
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
        controller.close();
      },
    });
  };
}

export const DEFAULT_SETTINGS = {
  maskAllInputs: true,
  blank: [BLANK_SELECTOR],
  replay: true,
  screenshot: false,
  console: true,
  network: true,
};

// --------------------------------------------------------------------------------------------
// Planting

function resetDocument() {
  document.documentElement.innerHTML = "<head></head><body></body>";
  document.title = "";
  window.history.replaceState({}, "", "/");
}

// Each position gets its own wrapper, so "which position leaked" is answerable from the DOM as
// well as from the registry, and so the `sensitive` and `blanked` zones can be built the same way
// for every position: blank the wrapper, or blank whatever the position put in it.
function plantInto(root, positions, mint) {
  const registry = new Map();
  for (const position of positions) {
    if (!position.plant) continue;
    const marker = mint(position.id);
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-pos", position.id);
    if (position.zone === "sensitive") wrapper.classList.add(BLANK_CLASS);
    root.appendChild(wrapper);
    position.plant({ doc: document, parent: wrapper, marker });
    if (position.zone === "blanked") {
      for (const child of wrapper.children) child.classList.add(BLANK_CLASS);
    }
    registry.set(marker, position);
  }
  return registry;
}

// The channels: markers that reach the bundle through a buffer rather than through serialisation.
// The elements go into the page here and the interactions that feed the buffers run after the
// recorder has taken its first snapshot, which is the order a real session has.
function plantChannels(root, by) {
  const blanked = document.createElement("div");
  blanked.className = BLANK_CLASS;
  blanked.setAttribute("data-pos", "channels/blanked");
  root.appendChild(blanked);

  const clickText = button(`Cost ${by.get("click-text")}`);
  const clickAria = button("Open");
  clickAria.setAttribute("aria-label", by.get("click-aria"));
  const clickData = button("Row");
  clickData.setAttribute("data-cost", by.get("click-data"));
  const clickId = button("Detail");
  clickId.setAttribute("id", by.get("click-id"));
  blanked.append(clickText, clickAria, clickData, clickId);

  const labelled = document.createElement("label");
  labelled.textContent = by.get("change-label");
  const labelledInput = document.createElement("input");
  labelledInput.type = "text";
  labelled.appendChild(labelledInput);
  const placeheld = field("text", { placeholder: by.get("change-placeholder") });
  const arialled = field("text", { "aria-label": by.get("change-aria") });
  const named = field("text", { name: by.get("change-name") });
  const fileLabel = document.createElement("label");
  fileLabel.textContent = by.get("change-file-label");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileLabel.appendChild(fileInput);
  blanked.append(labelled, placeheld, arialled, named, fileLabel);

  const ordinary = document.createElement("div");
  ordinary.setAttribute("data-pos", "channels/ordinary");
  root.appendChild(ordinary);
  const valued = field("text", { name: "note" });
  valued.value = by.get("change-value");
  const passworded = field("password", { name: "pw" });
  passworded.value = by.get("change-password");
  ordinary.append(valued, passworded);

  // The blanked element inside the described one, which is the shape a card-based dashboard
  // really has: the row is the clickable, the price is a span inside it, and the click lands on
  // the span. `closestTarget` walks up to a clickable that is not blanked; a describer that then
  // reads `textContent` walks straight back down through the blanked span.
  const nestedLink = document.createElement("a");
  nestedLink.setAttribute("data-view", "ring");
  const nestedPrice = blankedSpan(by.get("click-text-nested"));
  nestedLink.append(document.createTextNode("Open ring "), nestedPrice);
  ordinary.appendChild(nestedLink);

  // A form in ordinary page content whose fields are blanked: the submit describer is handed the
  // <form> and flattens its whole subtree.
  const nestedForm = document.createElement("form");
  nestedForm.append(blankedSpan(by.get("submit-text")), button("Save"));
  ordinary.appendChild(nestedForm);

  // And the same channel from the other direction: the form itself inside the blanked region.
  const blankedForm = document.createElement("form");
  blankedForm.appendChild(document.createTextNode(`Margin ${by.get("submit-blanked")}`));
  blanked.appendChild(blankedForm);

  // A field outside the blanked region whose <label for=…> is inside it. `el.labels` resolves a
  // label anywhere in the document, so nothing about the field says the label is blanked.
  const outsideLabel = document.createElement("label");
  outsideLabel.setAttribute("for", "fbh-outside-field");
  outsideLabel.textContent = by.get("change-label-outside");
  blanked.appendChild(outsideLabel);
  const outsideField = field("text", { id: "fbh-outside-field", name: "outside" });
  ordinary.appendChild(outsideField);

  document.title = `Rings — ${by.get("document-title")}`;
  window.history.replaceState({}, "", `/rings?token=${by.get("location-query")}`);

  return {
    markers: by,
    elements: {
      clicks: [clickText, clickAria, clickData, clickId, nestedPrice],
      changes: [
        labelledInput,
        placeheld,
        arialled,
        named,
        fileInput,
        valued,
        passworded,
        outsideField,
      ],
      submits: [nestedForm, blankedForm],
    },
  };
}

function blankedSpan(text) {
  const el = document.createElement("span");
  el.className = BLANK_CLASS;
  el.textContent = text;
  return el;
}

function button(text) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = text;
  return el;
}

function field(type, attrs) {
  const el = document.createElement("input");
  el.setAttribute("type", type);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

// --------------------------------------------------------------------------------------------
// Attachments. An image part is bytes, not text, so a marker is planted in the bytes: that is how
// the harness proves it really reads the binary parts rather than only the JSON.

function markedPng(marker) {
  const head = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const text = new TextEncoder().encode(`tEXtComment\0${marker}`);
  return new Blob([head, text], { type: "image/png" });
}

// --------------------------------------------------------------------------------------------
// The automatic screenshot, captured for real.
//
// jsdom cannot rasterise — `HTMLCanvasElement.toDataURL` is not implemented — and a PNG's pixels
// would not be searchable text even if it could. So a screenshot run stops one step short of the
// raster and scans what modern-screenshot hands the rasteriser: the cloned, style-inlined SVG the
// picture is drawn from. Everything up to that point is the real library doing the real work on
// the real page, with the real `filter` and the real `onCloneEachNode` this library passes it —
// which is the part `capture.blank` has to reach.
//
// Two options are added that the library does not pass: `font: false` and a stub `toDataURL`.
// Neither touches what is in the clone; both keep jsdom from reaching for a network and a canvas
// it does not have.
export async function cloneOnlyScreenshotModule() {
  const { domToForeignObjectSvg } = await import("modern-screenshot");
  return {
    domToBlob: async (node, options) => {
      const svg = await domToForeignObjectSvg(node, { ...options, font: false });
      return new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
    },
  };
}

function installCanvasStub() {
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (!proto || proto.toDataURL.fbhStub) return;
  // modern-screenshot asks the canvas whether webp is supported before it does anything else, and
  // jsdom answers by logging "Not implemented" and returning null, which throws one line later.
  const stub = () => "data:image/png;base64,iVBORw0KGgo=";
  stub.fbhStub = true;
  proto.toDataURL = stub;
}

// --------------------------------------------------------------------------------------------
// The run

export async function runCapture({
  settings = DEFAULT_SETTINGS,
  positions = buildPositions(),
  nonce = randomNonce(),
  interact = true,
} = {}) {
  installBlobPolyfill();
  if (settings.screenshot) installCanvasStub();
  resetWarnings();
  resetDocument();

  const mint = createMinter(nonce);
  const root = document.createElement("main");
  document.body.appendChild(root);

  const registry = plantInto(root, positions, mint);

  // One marker per channel, minted once and used once: the elements the interactions act on, the
  // reporter's own fields and the attachment bytes all read from this map, so nothing can be
  // registered under a marker that was never actually planted anywhere.
  const by = new Map();
  for (const position of positions) {
    if (!position.channel) continue;
    const marker = mint(position.id);
    registry.set(marker, position);
    by.set(position.channel, marker);
  }
  // A caller can pass a short position list with no channels in it (the self-test does), and then
  // there is nothing to plant and nothing to interact with. The reporter's own fields still have
  // to be filled with something, so they fall back to plain text that carries no marker.
  const channels = by.size ? plantChannels(root, by) : null;
  const reporterName = by.get("reporter-name") || "Dana";
  const sectionName = by.get("section-name") || "General";
  const reporterText = by.get("reporter-text") || "the price column is wrong";
  const imageMarker = by.get("image-bytes");
  const screenshotMarker = by.get("screenshot-bytes");

  const forms = [];
  const transport = {
    submit: async (form) => {
      forms.push(form);
      return { id: "report-1" };
    },
    list: async () => ({ items: [], nextCursor: null }),
    reply: async () => ({}),
    retry: async () => ({}),
  };

  const pending = [];
  const handle = mountFeedback(
    {
      hubUrl: "https://hub.example",
      app: "cad",
      env: "production",
      version: "sha-1",
      getToken: async () => "token",
      user: () => ({ id: "u-1", name: reporterName, email: "dana@example.com", role: "admin" }),
      section: () => sectionName,
      sections: ["Rendering", sectionName, "Catalog (SKU)"],
      capture: {
        replay: settings.replay,
        screenshot: settings.screenshot,
        console: settings.console,
        network: settings.network,
        maskAllInputs: settings.maskAllInputs,
        blank: settings.blank,
      },
    },
    {
      transport,
      storage: null,
      schedule: (fn) => {
        pending.push(fn());
      },
      loadRecorder: () => import("@rrweb/record"),
      loadScreenshot: settings.screenshot ? cloneOnlyScreenshotModule : undefined,
    },
  );
  await Promise.all(pending);
  await settle();

  // The same handful of positions again, now that the recorder is running and has taken its full
  // snapshot: these reach the recording through rrweb's mutation path, which is different code
  // from the snapshot path and carries most of a dashboard's session (see MUTATION_SUBSET).
  for (const [marker, position] of plantInto(root, mutationPositions(positions), mint)) {
    registry.set(marker, position);
  }
  await settle();

  if (interact && channels) await runInteractions(channels);
  await settle();

  const fields = {
    text: `The price column is wrong. ${reporterText}`,
    section: sectionName,
    type: "Bug",
    images: imageMarker ? [markedPng(imageMarker)] : [],
  };
  // Only when the run owns a `screenshot-bytes` marker does the harness hand submit() a PNG of
  // its own. Left out, `fields.screenshot` is undefined and mount takes the screenshot itself —
  // which is the path `capture.screenshot: true` uses in a real app, and the one no combination
  // exercised before (audit finding F4).
  if (screenshotMarker) fields.screenshot = markedPng(screenshotMarker);
  await handle.submit(fields);
  handle.destroy();

  const form = forms[0];
  if (!form) throw new Error("the harness submitted nothing: the capture path did not run");
  const parts = await readParts(form);
  return { parts, registry, settings, nonce, report: JSON.parse(partNamed(parts, "report").text) };
}

async function settle() {
  // Two macrotask turns: rrweb batches mutations behind requestAnimationFrame and flushes input
  // events on the next turn, so a single microtask drain is not enough to see them.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function runInteractions(channels) {
  for (const el of channels.elements.clicks) {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  }
  for (const el of channels.elements.changes) {
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
  }
  for (const el of channels.elements.submits) {
    el.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  }
  // The error buffer is always on and takes whatever the page throws. Both halves of what it
  // records are planted: the message, and a stack frame — through a function named after the
  // marker, which is the closest a test can get to "a stack frame says something about the app".
  throwMarkedError(channels.markers.get("error-message"), channels.markers.get("error-stack"));
  // The console and network buffers take what the app hands them, so the app has to hand them
  // something: one log line and two requests, one with the marker in the path and one with it in
  // the query string. Both requests fail, which is what the network buffer records.
  console.log("render failed for", channels.markers.get("console-arg"));
  await failedFetch(`/api/rings/${channels.markers.get("network-path")}`);
  await failedFetch(`/api/rings?token=${channels.markers.get("network-query")}`);
  window.history.pushState({}, "", `#${channels.markers.get("route-hash")}`);
  window.history.pushState({}, "", `/rings?token=${channels.markers.get("route-query")}`);
  window.history.replaceState({}, "", `/rings?token=${channels.markers.get("location-query")}`);
}

function throwMarkedError(messageMarker, stackMarker) {
  const named = {
    [`render${stackMarker}`]: () => {
      throw new Error(`cannot price ring at ${messageMarker}`);
    },
  }[`render${stackMarker}`];
  try {
    named();
  } catch (error) {
    // The event a browser fires for an uncaught error, which is what the buffer listens for.
    window.dispatchEvent(new window.ErrorEvent("error", { error, message: error.message }));
  }
}

async function failedFetch(url) {
  try {
    await window.fetch(url);
  } catch {
    // Offline in jsdom: the rejection is exactly what the network buffer records.
  }
}

// --------------------------------------------------------------------------------------------
// Reading the bundle back

async function readParts(form) {
  const parts = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") {
      parts.push({ name, encoding: "field", bytes: value.length, text: value });
      continue;
    }
    const buffer = Buffer.from(await value.arrayBuffer());
    if (name === "replay") {
      // The replay goes up gzipped, so "did a marker reach the bundle" is only answerable after
      // decompressing it. A harness that scanned the compressed bytes would pass every time.
      const json = gunzipSync(buffer).toString("utf8");
      parts.push({ name, encoding: "gzip+json", bytes: buffer.length, text: json });
      continue;
    }
    if (value.type === "application/json") {
      parts.push({ name, encoding: "json", bytes: buffer.length, text: buffer.toString("utf8") });
      continue;
    }
    // Binary parts are scanned as latin1 so any literal run of bytes that spells a marker is
    // found: an image is a picture of the page, not text, but a marker planted in its bytes is
    // what proves this scan runs at all.
    parts.push({ name, encoding: "binary", bytes: buffer.length, text: buffer.toString("latin1") });
  }
  return parts;
}

function partNamed(parts, name) {
  const found = parts.find((part) => part.name === name);
  if (!found) throw new Error(`no "${name}" part in the bundle`);
  return found;
}

// --------------------------------------------------------------------------------------------
// Scanning and reporting

const CONTEXT = 70;

export function scan({ parts, registry, settings }) {
  const results = [];
  const haystacks = parts.map((part) => ({ part, lower: part.text.toLowerCase() }));
  for (const [marker, position] of registry) {
    const fate = expectedFate(position, settings);
    const needle = marker.toLowerCase();
    const hits = [];
    for (const { part, lower } of haystacks) {
      let at = lower.indexOf(needle);
      while (at !== -1) {
        hits.push({ part: part.name, at, context: contextAt(part.text, at, marker.length) });
        at = lower.indexOf(needle, at + needle.length);
        if (hits.length > 8) break;
      }
    }
    results.push({ marker, position, fate, hits });
  }
  const leaked = results.filter((one) => one.fate.expect === "withheld" && one.hits.length);
  const missing = results.filter((one) => one.fate.expect === "published" && !one.hits.length);
  return { results, leaked, missing, parts, settings };
}

// A position planted twice — once before mount and once through a mutation afterwards — is two
// entries in the registry with the same id, so the phase has to be printed or a failure cannot be
// told apart from its twin.
function label(position) {
  return position.phase ? `${position.id} (${position.phase})` : position.id;
}

function contextAt(text, at, length) {
  const from = Math.max(0, at - CONTEXT);
  const to = Math.min(text.length, at + length + CONTEXT);
  const slice = text.slice(from, to).replace(/\s+/g, " ");
  return `${from > 0 ? "…" : ""}${slice}${to < text.length ? "…" : ""}`;
}

export function formatScan(result, { title = "marker scan", verbose = false } = {}) {
  const lines = [];
  const { settings } = result;
  lines.push(
    `${title}: maskAllInputs=${settings.maskAllInputs} blank=[${settings.blank.join(",")}] replay=${settings.replay}`,
  );
  lines.push(
    `  parts: ${result.parts.map((part) => `${part.name} (${part.encoding}, ${part.bytes} B)`).join(", ")}`,
  );
  lines.push(
    `  ${result.results.length} markers planted, ${result.leaked.length} leaked, ${result.missing.length} expected but missing`,
  );
  for (const one of result.leaked) {
    lines.push("");
    lines.push(`  LEAK  ${label(one.position)}`);
    lines.push(`        marker   ${one.marker}`);
    lines.push(`        planted  ${one.position.where}`);
    lines.push(`        expected withheld — ${one.fate.why}`);
    for (const hit of one.hits) {
      lines.push(`        found in ${hit.part} at byte ${hit.at}`);
      lines.push(`                 ${hit.context}`);
    }
  }
  for (const one of result.missing) {
    lines.push("");
    lines.push(`  MISSING  ${label(one.position)}`);
    lines.push(`           marker   ${one.marker}`);
    lines.push(`           planted  ${one.position.where}`);
    lines.push(`           expected published — ${one.fate.why}`);
    lines.push(`           nothing in: ${result.parts.map((part) => part.name).join(", ")}`);
  }
  if (verbose) {
    lines.push("");
    lines.push("  every position, in catalogue order:");
    lines.push(`  ${"fate".padEnd(10)}${"in".padEnd(22)}position`);
    for (const one of result.results) {
      const where = one.hits.length ? [...new Set(one.hits.map((hit) => hit.part))].join("+") : "—";
      const mark = one.fate.gap ? "GAP" : one.fate.expect;
      lines.push(`  ${mark.padEnd(10)}${where.padEnd(22)}${label(one.position)}`);
    }
  }
  return lines.join("\n");
}

export { BLANK_CLASS, BLANK_SELECTOR };
