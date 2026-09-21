// The panel (spec §5.4): one host element on the page, a shadow root so neither stylesheet can
// reach the other, and inside it the report form above "My reports". It is a modal dialog — a
// focus trap, Escape, a click on the backdrop, and focus handed back to whatever opened it. The
// panel is a consumer of the same headless API an app could use on its own (spec §5.4).
import { warnOnce } from "../warn.js";
import { el } from "./dom.js";
import { createForm } from "./form.js";
import { createList } from "./list.js";
import { PANEL_CSS } from "./styles.js";

export const HOST_ID = "fbh-host";
export const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The same "an app hook may never take the panel down" rule every other module in this library
// already applies to the host's own callbacks (form.js's and list.js's own `safeCall` twins):
// `theme()` runs on every open(), and a throw or a nonsense return (spec §5.4, standing rule 4)
// must fall back to light, not crash the panel.
function safeCall(fn, fallback, label) {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}

export function createPanel({ api, options, doc }) {
  const win = doc.defaultView;
  const host = doc.createElement("div");
  host.id = HOST_ID;
  host.dataset.theme = "light";
  const shadow = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);

  const list = createList({ api, options, doc });
  const form = createForm({
    api,
    options,
    doc,
    win,
    onSubmitted: (sent) => list.addOptimistic(sent),
  });

  const closeButton = el(doc, "button", {
    type: "button",
    class: "fbh-close",
    "aria-label": "Close",
    text: "✕",
    onClick: () => close(),
  });
  // tabindex="-1": never in the Tab order of its own accord, but a legitimate landing spot for
  // focus when open() finds nothing else focusable to send it to (see focusInto() below) — the
  // dialog itself, rather than nowhere, or worse, left behind on whatever the reporter clicked to
  // get here.
  const panelBox = el(doc, "div", { class: "fbh-panel", tabindex: "-1" }, [
    el(doc, "header", { class: "fbh-head" }, [
      el(doc, "h2", { class: "fbh-title", id: "fbh-title", text: "Report an issue or suggestion" }),
      closeButton,
    ]),
    el(doc, "div", { class: "fbh-body" }, [form.element, list.element]),
  ]);
  const overlay = el(
    doc,
    "div",
    {
      class: "fbh-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "fbh-title",
      hidden: true,
      onKeydown: onKeydown,
      onClick: (event) => {
        if (event.target === overlay) close();
      },
    },
    [panelBox],
  );
  shadow.appendChild(overlay);
  doc.body.appendChild(host);

  let open_ = false;
  let lastFocus = null;
  // The exact inline value document.documentElement.style.overflow held before open() touched it
  // — not merely "", since an app may already have set one (spec §5.4, standing rule 4: "closing
  // must restore whatever the page had"). null means "open() has not locked scrolling", the guard
  // close() itself uses so a second close() (or a close() with no matching open()) is a no-op.
  let previousOverflow = null;

  // Scopes the trap to whatever the *topmost* dialog is. Ordinarily that is the whole panel; but
  // annotate.js opens its own dialog (class "fbh-annotator", spec §5.4) inside the form while the
  // panel is open — a trap inside a trap — and that inner dialog has no Tab-cycling of its own
  // (only its own Escape). Scoping to it here, whenever it is present, is what keeps Tab from
  // wandering back out into the (visually dimmed, but otherwise ordinary) form and list behind it.
  function annotatorDialog() {
    return shadow.querySelector(".fbh-annotator");
  }

  function focusable(scope) {
    // No visibility test: jsdom has no layout, and everything inside the overlay is visible
    // whenever the overlay itself is.
    return [...scope.querySelectorAll(FOCUSABLE)].filter((node) => !node.hidden);
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      // The nested dialog owns Escape while it is open — closing itself, not the whole panel.
      // Its own listener lives on `doc` (annotate.js's openAnnotator), reached only if this
      // handler leaves the event alone: stopping it here, as the normal case below does, would
      // mean Escape from inside the annotator always took out both at once.
      if (annotatorDialog()) return;
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable(annotatorDialog() || shadow);
    if (!items.length) return;
    const index = items.indexOf(shadow.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (!event.shiftKey && index === items.length - 1) {
      event.preventDefault();
      items[0].focus();
    }
  }

  // Moves focus into the dialog on open(). The dialog can, briefly or in a degenerate
  // configuration, hold nothing focusable at all (spec §5.4, standing rule 2) — the panel box
  // itself, focusable only via its tabindex="-1", is where focus goes instead, so a keyboard
  // reporter always lands inside the dialog and never on whatever they clicked to open it.
  function focusInto() {
    const items = focusable(shadow);
    if (items.length) items[0].focus();
    else panelBox.focus();
  }

  function lockScroll() {
    if (previousOverflow !== null) return;
    previousOverflow = doc.documentElement.style.overflow;
    doc.documentElement.style.overflow = "hidden";
  }

  function unlockScroll() {
    if (previousOverflow === null) return;
    doc.documentElement.style.overflow = previousOverflow;
    previousOverflow = null;
  }

  function open() {
    if (open_) return;
    open_ = true;
    lastFocus = doc.activeElement;
    host.dataset.theme = safeCall(options.theme, "light", "theme()") === "dark" ? "dark" : "light";
    lockScroll();
    overlay.hidden = false;
    form.prepare().catch(() => {});
    list.start();
    focusInto();
  }

  function close() {
    if (!open_) return;
    open_ = false;
    overlay.hidden = true;
    unlockScroll();
    form.release();
    list.stop();
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  function destroy() {
    close();
    form.destroy();
    list.destroy();
    host.remove();
  }

  return { open, close, destroy, host, isOpen: () => open_ };
}
