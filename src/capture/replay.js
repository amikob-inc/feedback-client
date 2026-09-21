// The session replay (spec §5.2): rrweb with a checkout every minute, two segments kept, so a
// report carries between sixty and a hundred and twenty seconds of what the reporter did — and
// nothing older, which is as much a privacy decision as a size one. The recorder is imported
// dynamically on the first idle callback: recording starts about a second after load without the
// app's own start-up paying for it. At submit both segments are serialized; over the cap the
// previous one goes first (spec §5.2), and if the current one alone is still too big there is no
// replay part at all.
import { byteLength } from "../bytes.js";
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
// `submit`, `button`, `reset` and `image` are deliberately absent: their value is the button's
// visible label, not anything a person typed, and masking it would put `*****` on a button in the
// replay for no gain. (rrweb ignores the first two for masking in any case.)
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

// Strips the query string out of a URL and keeps everything else, including the fragment. Never
// throws: an href this cannot parse is cut by hand rather than passed through, because passing it
// through is the failure that matters.
export function stripQuery(href) {
  const text = typeof href === "string" ? href : "";
  try {
    const url = new URL(text);
    url.search = "";
    return url.toString();
  } catch {
    const at = text.indexOf("?");
    if (at === -1) return text;
    const hash = text.indexOf("#", at);
    return hash === -1 ? text.slice(0, at) : text.slice(0, at) + text.slice(hash);
  }
}

// The Meta event is the one place the recorder writes the page's own address, and it writes the
// whole of it. mount.js's `pageContext` deliberately sends `pathname + hash` and never the query,
// because cad-dashboard's router puts a magic-link token in one — so a recording that carries the
// query straight past that decision undoes it. Every event goes through here on its way into the
// segments; everything that is not a Meta event is passed along untouched, by identity.
export function scrubReplayEvent(event) {
  if (!event || event.type !== META_EVENT) return event;
  const data = event.data;
  if (!data || typeof data.href !== "string" || !data.href.includes("?")) return event;
  return { ...event, data: { ...data, href: stripQuery(data.href) } };
}

export function rrwebOptions({ maskAllInputs = false, blank = [] } = {}, emit) {
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
  if (blank && blank.length) options.blockSelector = blank.join(",");
  return options;
}

export function idle(fn) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => fn(), { timeout: 2000 });
  else setTimeout(fn, 200);
}

export function startReplay(
  capture,
  { load = () => import("@rrweb/record"), schedule = idle } = {},
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
        stopFn = record(
          rrwebOptions(capture, (event, isCheckout) =>
            segments.push(scrubReplayEvent(event), !!isCheckout),
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
