// mountFeedback (spec §5.5) and the headless API behind the panel (spec §5.4, "Headless use").
// Everything the app gave us is a function called lazily, at open or submit, so mounting reads no
// app state and the module can be imported in any order. The second argument is a seam for tests
// and for an app that brings its own panel: it is not part of the public option object, so a typo
// there is a missing feature, not a thrown OptionError.
import { installBuffers } from "./buffers/install.js";
import { CAPS, buildBundle, buildReport } from "./bundle.js";
import { gzip } from "./capture/gzip.js";
import { idle, serializeReplay, startReplay } from "./capture/replay.js";
import { captureScreenshot } from "./capture/screenshot.js";
import { defaultSection, normalizeOptions } from "./options.js";
import { attentionIds, markSeen, readSeen, safeStorage, seenKey, writeSeen } from "./seen.js";
import { FeedbackError, createTransport } from "./transport.js";
import { warnOnce } from "./warn.js";

// Task 13 sets this to the built-in panel; until then a mount without its own `createPanel` is
// headless and `open()` says so once.
const defaultPanelFactory = null;

// Standing rule 1: none of the app's own hooks (getToken is guarded inside transport.js instead,
// since it is only ever called from there) may take the app down. Every call site below goes
// through this so a throwing `user`, `section`, `theme` or `onSummary` degrades to a fallback
// value and one warning instead of an uncaught exception escaping into the host page.
function safeCall(fn, fallback, label = "callback") {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}

// A host hook can return anything at all, and what it returns ends up inside the report JSON.
// Catching a throw is only half the guard: a hook that succeeds and hands back an object — a
// circular one, say, or one whose toString throws — would otherwise reach JSON.stringify in the
// bundle builder and take submit() down with a raw TypeError, which is exactly the "the library
// may never break the host application" rule, one hook short. Everything a hook returns becomes
// a string here, or nothing.
function asText(value, label) {
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch (err) {
    warnOnce(`${label} value`, err);
    return "";
  }
}

export function resolveButton(button, doc) {
  if (!button) return null;
  if (typeof button === "string") return doc.querySelector(button);
  return typeof button.addEventListener === "function" ? button : null;
}

export function pageContext({ doc, win, options }) {
  const nav = win.navigator || {};
  return {
    // pathname + hash only, deliberately: a query string can carry a token (cad-dashboard's own
    // router puts one in a magic-link redirect), and nothing here may capture that.
    path: `${win.location.pathname}${win.location.hash}`,
    view: asText(safeCall(options.section, "", "section()"), "section()"),
    title: asText(doc.title, "document.title"),
    viewport: [win.innerWidth || 0, win.innerHeight || 0],
    dpr: win.devicePixelRatio || 1,
    theme: safeCall(options.theme, "light", "theme()") === "dark" ? "dark" : "light",
    language: nav.language || "",
    online: nav.onLine !== false,
  };
}

function inertHandle() {
  const noop = () => {};
  return {
    open: noop,
    close: noop,
    async submit() {
      return null;
    },
    async list() {
      return { items: [], nextCursor: null };
    },
    async reply() {
      return null;
    },
    async retry() {
      return null;
    },
    destroy: noop,
  };
}

export function mountFeedback(rawOptions, deps = {}) {
  const options = normalizeOptions(rawOptions);
  const doc = deps.doc || document;
  const win = deps.win || doc.defaultView || window;
  const button = resolveButton(options.button, doc);

  // No hub URL: the feature is off, the app's button is hidden and every call is a no-op
  // (spec §5.5, standing rule 5). This is also the emergency switch — a redeploy without the
  // variable — so nothing below this line may run: no buffer installs, no replay, no storage
  // read, no transport built. A dashboard with the feature off pays nothing at all for it.
  if (!options.hubUrl) {
    if (button) button.hidden = true;
    return inertHandle();
  }
  if (button) button.hidden = false;

  const transport =
    deps.transport ||
    createTransport({
      hubUrl: options.hubUrl,
      app: options.app,
      getToken: options.getToken,
      fetch: deps.fetch,
    });
  const buffers = installBuffers({ win, doc, capture: options.capture });
  const replay = options.capture.replay
    ? startReplay(options.capture, { load: deps.loadRecorder, schedule: deps.schedule })
    : null;
  const storage = deps.storage !== undefined ? deps.storage : safeStorage(win);
  const schedule = deps.schedule || idle;

  let panel = null;
  let seen = {};
  let seenFor = null;
  let attention = -1;
  let destroyed = false;

  function currentUser() {
    return safeCall(options.user, null, "user()");
  }

  function loadSeen() {
    const user = currentUser();
    const key = seenKey(options.app, user && user.id);
    if (key !== seenFor) {
      seenFor = key;
      seen = readSeen(storage, key);
    }
    return key;
  }

  function publishSummary(items) {
    loadSeen();
    const count = attentionIds(items, seen).length;
    if (count === attention) return count;
    attention = count;
    safeCall(() => options.onSummary({ attention: count }), undefined, "onSummary()");
    return count;
  }

  async function list() {
    const page = await transport.list();
    publishSummary(page.items);
    return page;
  }

  // The panel calls this once it has rendered a page of reports: what the reporter has now seen
  // stops counting towards the dot.
  function markRead(items) {
    const key = loadSeen();
    const next = markSeen(seen, items);
    if (next.changed) {
      seen = next.seen;
      writeSeen(storage, key, seen);
    }
    publishSummary(items);
  }

  function captureNow() {
    return captureScreenshot({ load: deps.loadScreenshot, target: doc.body });
  }

  async function replayPart() {
    if (!replay) return null;
    const serialized = serializeReplay(replay.segments);
    if (!serialized || !serialized.json) return null;
    return gzip(serialized.json);
  }

  async function submit(fields = {}) {
    const text = String(fields.text || "").trim();
    if (!text) {
      throw new FeedbackError("Add a description before sending.", {
        status: 400,
        code: "invalid_text",
      });
    }
    if (text.length > CAPS.text) {
      throw new FeedbackError(`Keep the description under ${CAPS.text} characters.`, {
        status: 400,
        code: "invalid_text",
      });
    }

    const section =
      fields.section ||
      defaultSection(options.sections, safeCall(options.section, "", "section()"));
    const type = fields.type || options.types[0];
    const images = Array.isArray(fields.images) ? fields.images : [];
    const screenshot =
      fields.screenshot !== undefined
        ? fields.screenshot
        : options.capture.screenshot
          ? await captureNow()
          : null;
    const replayBlob = fields.includeReplay === false ? null : await replayPart();

    const report = buildReport({
      app: options.app,
      env: options.env,
      version: options.version,
      section,
      type,
      text,
      reporter: currentUser(),
      page: pageContext({ doc, win, options }),
      browser: { userAgent: (win.navigator && win.navigator.userAgent) || "" },
      at: new Date().toISOString(),
      capture: {
        replay: !!replayBlob,
        screenshot: !!screenshot,
        maskAllInputs: options.capture.maskAllInputs,
      },
      breadcrumbs: buffers.breadcrumbs(),
      console: buffers.console(),
      errors: buffers.errors(),
      network: buffers.network(),
    });

    const bundle = buildBundle({ report, screenshot, replay: replayBlob, images });
    const answer = await transport.submit(bundle.form);
    return { id: answer.id, dropped: bundle.dropped };
  }

  async function reply(id, value) {
    const text = String(value || "").trim();
    if (!text)
      throw new FeedbackError("Write a reply first.", { status: 400, code: "invalid_text" });
    if (text.length > CAPS.reply) {
      throw new FeedbackError(`Keep the reply under ${CAPS.reply} characters.`, {
        status: 400,
        code: "invalid_text",
      });
    }
    return transport.reply(id, text);
  }

  function retry(id) {
    return transport.retry(id);
  }

  function ensurePanel() {
    if (panel || destroyed) return panel;
    const factory = deps.createPanel || defaultPanelFactory;
    if (!factory) {
      warnOnce("panel", new Error("this build was mounted headless: open() has no panel to show"));
      return null;
    }
    panel = factory({ api: internal, options, doc });
    return panel;
  }

  function open() {
    const current = ensurePanel();
    if (current) current.open();
  }

  function close() {
    if (panel) panel.close();
  }

  function onButtonClick(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    open();
  }

  function destroy() {
    // Idempotent by construction, not by a destroyed-guard around the whole body: every step
    // below already tolerates being run again (removeEventListener on an already-detached
    // listener, `replay.stop()` and `buffers.uninstall()` are both safe to call twice), so
    // calling destroy() a second time, or before open() was ever used, costs nothing and leaves
    // nothing extra behind.
    destroyed = true;
    if (button) button.removeEventListener("click", onButtonClick);
    if (panel) panel.destroy();
    panel = null;
    if (replay) replay.stop();
    buffers.uninstall();
  }

  const handle = { open, close, submit, list, reply, retry, destroy };
  // What the panel gets: the same seven functions plus the two it alone needs.
  const internal = { ...handle, markRead, captureScreenshot: captureNow, options };

  if (button) button.addEventListener("click", onButtonClick);
  // One listing after the first idle callback, so the app's topbar dot is right before anyone
  // opens the panel. A signed-out visitor has no token and the call is dropped silently. This is
  // the mount's only timer and it fires at most once: nothing here repeats, so there is nothing
  // to stack, and the `destroyed` check keeps a slow first tick from doing anything once
  // destroy() has already run.
  schedule(() => {
    if (destroyed) return;
    list().catch(() => {});
  });

  return handle;
}
