// The session replay (spec §5.2): rrweb with a checkout every minute, two segments kept, so a
// report carries between sixty and a hundred and twenty seconds of what the reporter did — and
// nothing older, which is as much a privacy decision as a size one. The recorder is imported
// dynamically on the first idle callback: recording starts about a second after load without the
// app's own start-up paying for it. At submit both segments are serialized; over the cap the
// previous one goes first (spec §5.2), and if the current one alone is still too big there is no
// replay part at all.
import { byteLength } from "../bytes.js";
import { scrubHref } from "../url.js";
import { blankSelector } from "../selectors.js";
import { warnOnce } from "../warn.js";

export const REPLAY_JSON_MAX = 8 * 1024 * 1024;
export const CHECKOUT_MS = 60000;
export const SAMPLING = { mousemove: 50, scroll: 150, input: "last" };

// rrweb's Meta event. Its `data.href` is `window.location.href` — the whole URL, query string
// included — and stripping the query there is the one place this library can do it.
export const META_EVENT = 4;

// Field kinds that are masked whatever the app asked for. `password` is obvious. `hidden` is not
// on screen at all, so masking it costs the recording nothing and a hidden field is where a
// server-rendered page puts a CSRF token, a record id or a price. `file` is the one the
// breadcrumb buffer already refuses to record (src/buffers/breadcrumbs.js): a file input's value
// is a fake path the browser substitutes, and the fake path still names the file.
export const ALWAYS_MASKED_INPUTS = { password: true, hidden: true, file: true };

// Everything else rrweb can mask, named one by one rather than through its `maskAllInputs: true`
// shorthand. The shorthand expands to a fixed list inside rrweb that leaves out `hidden`, `file`,
// `reset` and `image`, and — this is the part that matters — it *replaces* any `maskInputOptions`
// passed alongside it, so the shorthand and a correction cannot be combined. Naming the kinds
// here is what lets the three above be added. Found by the marker harness
// (tests/leak-matrix.test.js), not by reading rrweb.
//
// Six kinds are deliberately absent, and the reason is the same for all six: their `value` is
// markup rather than anything a person typed. `submit`, `button`, `reset` and `image` carry the
// button's visible label, so masking it would put `*****` on a button in the replay for no gain.
// `checkbox` and `radio` carry the option's key, and what is private about them is which one is
// checked — which rrweb publishes as `attributes.checked` with no option to consult, and which is
// therefore covered by `capture.blank` or not at all. Naming them here would change nothing in the
// snapshot path (rrweb skips the masking branch for both, record.js:1080) and would take effect
// only on the mutation path (record.js:2172-2182), so the same field would be masked or not
// depending on when it was added to the page. Left out on purpose, and this is the reason (audit
// finding F8).
export const MASKABLE_INPUTS = [
  "color",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "range",
  "search",
  "select",
  "tel",
  "text",
  "textarea",
  "time",
  "url",
  "week",
];

// A contenteditable region is a field in every sense except rrweb's: no `maskInputOptions` key
// covers it, and its content is an ordinary text node to the recorder. `maskTextSelector` is the
// option that does cover it, and this library was not passing one at all.
export const EDITABLE_SELECTOR = '[contenteditable]:not([contenteditable="false"])';

// What rrweb leaves out of the recording when asked. Comments and <script> elements are the two
// that carry data no one can see on screen: a server-rendered page routinely leaves request ids,
// e-mail addresses and whole JSON dumps of its state in both. The head `meta` groups are rrweb's
// own names for tokens and verification codes. This is rrweb's `slimDOMOptions: "all"` minus
// `headTitleMutations`, which is kept because a dashboard retitles itself on every route change
// and the replay should follow.
export const SLIM_DOM = {
  script: true,
  comment: true,
  headFavicon: true,
  headWhitespace: true,
  headMetaDescKeywords: true,
  headMetaSocial: true,
  headMetaRobots: true,
  headMetaHttpEquiv: true,
  headMetaAuthorship: true,
  headMetaVerification: true,
};

export function createSegments() {
  let previous = [];
  let current = [];
  return {
    push(event, isCheckout) {
      if (isCheckout && current.length) {
        previous = current;
        current = [];
      }
      current.push(event);
    },
    previous: () => previous,
    current: () => current,
    dropPrevious() {
      previous = [];
    },
    events: () => previous.concat(current),
    count: () => previous.length + current.length,
    clear() {
      previous = [];
      current = [];
    },
  };
}

export function serializeReplay(segments, { max = REPLAY_JSON_MAX } = {}) {
  if (segments.count() === 0) return null;
  let json = JSON.stringify(segments.events());
  let dropped = false;
  if (byteLength(json) > max && segments.previous().length) {
    segments.dropPrevious();
    json = JSON.stringify(segments.events());
    dropped = true;
  }
  if (byteLength(json) > max) return { json: null, dropped: true, tooBig: true };
  return { json, dropped, tooBig: false };
}

export function maskInputOptionsFor(maskAllInputs) {
  const options = { ...ALWAYS_MASKED_INPUTS };
  if (maskAllInputs) for (const kind of MASKABLE_INPUTS) options[kind] = true;
  return options;
}

// Every URL a serialised node can carry. rrweb absolutises each of them against the document and
// writes it whole, so a token in a query string travels in an anchor exactly as it travels in the
// Meta event — and this library already strips the query in four other places (`pageContext`, the
// Meta event, every network entry, the route breadcrumb) for that one reason: cad-dashboard's
// router puts a magic-link token in one. An anchor back to the current page is the same token, so
// it gets the same treatment. The cost is a replay whose signed or cache-busted image URLs no
// longer resolve — a broken image rather than a live credential, which is the right way round.
export const URL_ATTRIBUTES = [
  "href",
  "src",
  "srcset",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
  // rrweb renames an iframe's `src` rather than scrubbing it (record.js:1192-1197).
  "rr_src",
];

// The three tag names whose `value` attribute is a field's content rather than markup.
// `maskInputOptions` is keyed by input type *and* by tag name, which is how `select` and
// `textarea` are named in MASKABLE_INPUTS.
const FIELD_TAGS = new Set(["input", "textarea", "select"]);

// rrweb's serialised node types; 2 is an element.
const ELEMENT_NODE = 2;

export const FULL_SNAPSHOT_EVENT = 2;
export const INCREMENTAL_SNAPSHOT_EVENT = 3;

function scrubSrcset(value) {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      const space = trimmed.search(/\s/);
      if (space === -1) return scrubHref(trimmed);
      return `${scrubHref(trimmed.slice(0, space))}${trimmed.slice(space)}`;
    })
    .join(", ");
}

// One attribute bag, scrubbed. Returns the bag it was given, by identity, when there was nothing
// to do — which is what keeps a whole snapshot passing through untouched when it is clean.
// `tagName` is empty for an attribute *mutation*, where rrweb sends the changed attributes with
// no tag name; rrweb already masks a `value` there itself (record.js:2172-2182), so the only
// thing lost by not knowing the tag is nothing.
export function scrubAttributes(tagName, attributes, maskInputOptions = {}) {
  if (!attributes || typeof attributes !== "object") return attributes;
  const tag = String(tagName || "").toLowerCase();
  let out = null;
  const set = (name, value) => {
    if (!out) out = { ...attributes };
    if (value === undefined) delete out[name];
    else out[name] = value;
  };

  // A blocked element is reduced by rrweb to exactly {class, rr_width, rr_height}, so its class
  // name survives the block — `class="cost-1240 fbh-blank"` publishes what the app asked to hide.
  // `needBlock` is deleted before the event is emitted, so the shape is what identifies it;
  // `rr_width` is set nowhere else in rrweb. The placeholder keeps its box, because the box is
  // those two px measurements and not the class. (Audit finding F9/G2.)
  if (attributes.rr_width !== undefined && attributes.rr_height !== undefined) {
    if (attributes.class !== undefined) set("class", undefined);
  }

  // A whole document in one attribute. rrweb deletes an iframe's `src` and never touches
  // `srcdoc`; `keepIframeSrcFn` governs only `src`. This is the third review in which srcdoc has
  // escaped. (Audit finding F9/G1.)
  if (attributes.srcdoc !== undefined && (tag === "iframe" || tag === "")) {
    set("srcdoc", undefined);
  }

  // rrweb masks a field's value only when the live `.value` is truthy (record.js:1080-1082), so a
  // server-rendered `value=` that script has cleared, or one the browser rejected as invalid for
  // the type, is serialised raw — on a `type="password"` as readily as anywhere else. Masking
  // here needs no knowledge of the live value, which is exactly what is missing there. (Audit
  // findings F3 and F9/G3.)
  if (FIELD_TAGS.has(tag) && typeof attributes.value === "string" && attributes.value) {
    const type = String(attributes.type || (tag === "input" ? "text" : tag)).toLowerCase();
    if (maskInputOptions[tag] || maskInputOptions[type]) {
      set("value", "*".repeat(attributes.value.length));
    }
  }

  for (const name of URL_ATTRIBUTES) {
    const value = attributes[name];
    // A query string, or a fragment that could be carrying parameters (`#access_token=…`).
    if (typeof value !== "string" || !(value.includes("?") || value.includes("#"))) continue;
    set(name, name === "srcset" ? scrubSrcset(value) : scrubHref(value));
  }
  return out || attributes;
}

function scrubNode(node, maskInputOptions) {
  if (!node || typeof node !== "object") return node;
  let next = node;
  if (node.type === ELEMENT_NODE) {
    const attributes = scrubAttributes(node.tagName, node.attributes, maskInputOptions);
    if (attributes !== node.attributes) next = { ...node, attributes };
  }
  if (Array.isArray(node.childNodes)) {
    let changed = false;
    const children = node.childNodes.map((child) => {
      const one = scrubNode(child, maskInputOptions);
      if (one !== child) changed = true;
      return one;
    });
    if (changed) next = { ...next, childNodes: children };
  }
  return next;
}

function scrubAdds(adds, maskInputOptions) {
  let changed = false;
  const out = adds.map((add) => {
    if (!add || typeof add !== "object") return add;
    const node = scrubNode(add.node, maskInputOptions);
    if (node === add.node) return add;
    changed = true;
    return { ...add, node };
  });
  return changed ? out : adds;
}

function scrubAttributeMutations(entries, maskInputOptions) {
  let changed = false;
  const out = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const attributes = scrubAttributes("", entry.attributes, maskInputOptions);
    if (attributes === entry.attributes) return entry;
    changed = true;
    return { ...entry, attributes };
  });
  return changed ? out : entries;
}

// The emit callback: the one place this library sees rrweb's output before it becomes a segment,
// and therefore the only lever it has over what rrweb has no option for. Three of those are
// closed here (the blocked element's class, an iframe's srcdoc, a field's raw `value=`), plus the
// query strings — in the Meta event, which is the page's own address, and in every URL a
// serialised node carries, which is every other address on the page.
//
// Copy-on-write throughout: rrweb keeps its own references to what it emits, so nothing here
// mutates an event, and an event with nothing to scrub is returned by identity so the common case
// costs one walk and no allocation.
export function scrubReplayEvent(event, maskInputOptions = ALWAYS_MASKED_INPUTS) {
  if (!event) return event;
  const data = event.data;
  if (event.type === META_EVENT) {
    if (!data || typeof data.href !== "string" || !data.href.includes("?")) return event;
    return { ...event, data: { ...data, href: scrubHref(data.href) } };
  }
  if (event.type === FULL_SNAPSHOT_EVENT && data && data.node) {
    const node = scrubNode(data.node, maskInputOptions);
    return node === data.node ? event : { ...event, data: { ...data, node } };
  }
  // A mutation, identified by its shape rather than by its source number: added nodes come
  // through `adds`, attribute changes through `attributes`.
  if (event.type === INCREMENTAL_SNAPSHOT_EVENT && data) {
    const adds = Array.isArray(data.adds) ? scrubAdds(data.adds, maskInputOptions) : data.adds;
    const attributes = Array.isArray(data.attributes)
      ? scrubAttributeMutations(data.attributes, maskInputOptions)
      : data.attributes;
    if (adds === data.adds && attributes === data.attributes) return event;
    return { ...event, data: { ...data, adds, attributes } };
  }
  return event;
}

export function rrwebOptions(
  { maskAllInputs = false, blank = [] } = {},
  emit,
  doc = globalThis.document,
) {
  const options = {
    emit,
    checkoutEveryNms: CHECKOUT_MS,
    // `maskAllInputs` stays false on purpose and the kinds are named in `maskInputOptions`
    // instead: rrweb throws away any maskInputOptions given alongside `maskAllInputs: true`, and
    // its own expansion of the flag omits `hidden` and `file`. See the notes on the constants.
    maskAllInputs: false,
    maskInputOptions: maskInputOptionsFor(maskAllInputs),
    slimDOMOptions: { ...SLIM_DOM },
    sampling: { ...SAMPLING },
    recordCanvas: false,
  };
  if (maskAllInputs) options.maskTextSelector = EDITABLE_SELECTOR;
  // Not `blank.join(",")`: rrweb takes one string, and one selector in it that the engine cannot
  // parse makes the whole string unusable — which rrweb answers by blocking nothing at all, in
  // silence (see src/selectors.js). The unusable entries are dropped and named here instead, so
  // an app that ships one typo keeps the protection of every selector it got right.
  const selector = blankSelector(blank, doc);
  if (selector) options.blockSelector = selector;
  return options;
}

export function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2000 });
  else setTimeout(fn, 200);
}

export function startReplay(
  capture,
  { load = () => import("@rrweb/record"), schedule = idle, doc = globalThis.document } = {},
) {
  const segments = createSegments();
  let stopFn = null;
  let stopped = false;

  const ready = new Promise((resolve) => {
    schedule(async () => {
      try {
        const module = await load();
        const record = module.record || module.default;
        if (typeof record !== "function") throw new Error("@rrweb/record exports no record()");
        if (stopped) {
          resolve(false);
          return;
        }
        const maskInputOptions = maskInputOptionsFor(capture && capture.maskAllInputs);
        stopFn = record(
          rrwebOptions(
            capture,
            (event, isCheckout) =>
              segments.push(scrubReplayEvent(event, maskInputOptions), !!isCheckout),
            doc,
          ),
        );
        // @rrweb/record@2.1.6's own record() wraps its whole body in a try/catch that logs to
        // console.warn and falls off the end on internal failure (verified in
        // node_modules/.pnpm/rrweb@2.1.6/.../dist/rrweb.js) — it does not throw. Its own type
        // signature says so too: `record<T>(options?): listenerHandler | undefined`. Left
        // unchecked, that path would resolve `ready` true and claim a recording that never
        // started, with no warning of our own ever firing. Treating "no stop handle" as a
        // failure funnels it through the same warn-once-and-carry-on path as a load failure.
        if (typeof stopFn !== "function") {
          throw new Error("@rrweb/record record() did not start (no stop handle returned)");
        }
        resolve(true);
      } catch (err) {
        warnOnce("session replay", err);
        resolve(false);
      }
    });
  });

  return {
    segments,
    ready,
    stop() {
      stopped = true;
      try {
        if (stopFn) stopFn();
      } catch (err) {
        warnOnce("session replay stop", err);
      }
      stopFn = null;
    },
  };
}
