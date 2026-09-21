// The report form (spec §5.4): the two dropdowns, the description, the attachment strip and
// Submit. The strip holds the automatic screenshot — taken when the panel opens, before the
// overlay is shown, so the reporter sees the page they are reporting on and not this form — plus
// anything pasted, attached or captured. Everything is optional and removable: the reporter sees
// what is going before it goes (spec §5.7). There is no page-copy attachment any more (removed
// 2026-09-21, see src/bundle.js's own note): the strip only ever holds the screenshot and images,
// and "What will be sent" never claims a page copy.
import { CAPS, describeAttachments } from "../bundle.js";
import {
  captureScreen as defaultCaptureScreen,
  screenCaptureSupported,
} from "../capture/screen.js";
import { defaultSection } from "../options.js";
import { warnOnce } from "../warn.js";
import { openAnnotator as defaultOpenAnnotator } from "./annotate.js";
import { clear, el } from "./dom.js";

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg"];

// This library may never break the host application: an app's own `section()` hook is exactly
// the kind of callback that can throw for reasons outside this module's control. mount.js already
// guards every such hook with the same pattern (see its `safeCall`); this is that pattern's twin
// for the one app hook the form itself calls.
function safeCall(fn, fallback, label) {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}

function isAcceptedImage(blob) {
  return !!blob && ACCEPTED_IMAGE_TYPES.includes(blob.type);
}

function isWithinImageCap(blob) {
  return blob.size <= CAPS.image;
}

// The same two checks addImage() applies to a freshly attached image (file picker, paste, screen
// capture), worded for a freshly attached one.
function attachProblem(blob) {
  if (!isAcceptedImage(blob)) return "Only PNG and JPEG images can be attached.";
  if (!isWithinImageCap(blob)) return "That image is over 5 MB.";
  return null;
}

// The hub rejects the *whole* report when an image part is not image/png or image/jpeg (plan's
// Global Constraints §9), and it enforces the same 5 MB cap addImage() already does. `toPngBlob`
// in annotate.js asks canvas.toBlob for "image/png", but asking is not the same as getting one
// back, and a large enough source image can flatten into a PNG over the cap even when the source
// attachment was under it — so a flattened drawing needs the identical two checks before it
// replaces an attachment, worded for what actually happened (a drawing, not a new attachment).
function drawProblem(blob) {
  if (!isAcceptedImage(blob)) {
    return "That drawing could not be attached: only PNG and JPEG images are allowed.";
  }
  if (!isWithinImageCap(blob)) return "That drawing is over 5 MB and could not be attached.";
  return null;
}

export function createForm({
  api,
  options,
  doc,
  win = doc.defaultView,
  onSubmitted = () => {},
  captureScreen = defaultCaptureScreen,
  openAnnotator = defaultOpenAnnotator,
}) {
  let screenshot = null;
  let includeReplay = true;
  let busy = false;
  let pasting = false;
  // Whether a recording will really be in the next submit, not merely whether the app asked for
  // one. Starts false (honest: nothing is attached yet) and flips to true only once `api`
  // confirms the recorder actually started — never sooner, since sooner would be a guess, and the
  // note that reads this is a promise to the reporter about what is about to leave the building.
  let replayAttached = false;
  const images = [];
  const urls = [];
  // Tracks whatever annotate() currently has open, so destroy() can close it (see below): its
  // pointermove/pointerup/keydown listeners live on `doc`, independent of this form's own DOM, so
  // an open dialog would otherwise keep running after the form itself is gone.
  let activeAnnotator = null;
  let destroyed = false;

  const sectionSelect = el(doc, "select", { id: "fbh-section", class: "fbh-input" });
  const typeSelect = el(doc, "select", { id: "fbh-type", class: "fbh-input" });
  const textarea = el(doc, "textarea", {
    id: "fbh-text",
    class: "fbh-input fbh-textarea",
    rows: "4",
    maxlength: String(CAPS.text),
    required: true,
    placeholder: "What happened, and what did you expect?",
  });
  const strip = el(doc, "div", { class: "fbh-strip" });
  // Hidden until a Draw button opens it; the panel's own DOM, not the annotator's, controls
  // visibility (annotate.js knows nothing about the form around it). See annotate() below.
  const annotatorMount = el(doc, "div", { class: "fbh-annotator-mount", hidden: true });
  const note = el(doc, "p", { class: "fbh-note" });
  // aria-atomic: the whole line is replaced on every update (never a partial diff a reporter
  // could misread as the complete list of attachments), so a screen reader must announce it whole
  // too. role="status" + aria-live="polite" covers both the informational states (sending, sent,
  // left-out-on-submit) and the failure states (every state must be announced, not only shown in
  // colour) without interrupting whatever the reporter is doing, the way an assertive region
  // would. tabindex="-1": not part of the tab order, but a deliberate, announced place for
  // keyboard focus to land when the control it was on is about to be removed from under it (see
  // hideRetry()) — never nowhere, never <body>.
  const message = el(doc, "p", {
    class: "fbh-message",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    tabindex: "-1",
  });
  // A retry button belongs next to the message, never inside it: role="status" is meant to be
  // read as one announcement, and a focusable control nested inside a live region gets its own
  // text ("Retry") folded into that announcement and into the region's own textContent, so the
  // failure message a reporter (or a test) reads back is no longer the words the hub sent.
  const retrySlot = el(doc, "span", { class: "fbh-retry-slot" });
  const fileInput = el(doc, "input", {
    id: "fbh-file",
    type: "file",
    accept: ACCEPTED_IMAGE_TYPES.join(","),
    multiple: true,
    class: "fbh-hidden-file",
    onChange: onFilesPicked,
  });
  const attachButton = el(doc, "button", {
    id: "fbh-attach",
    type: "button",
    class: "fbh-ghost",
    text: "Attach image",
    onClick: () => fileInput.click(),
  });
  const actions = el(doc, "div", { class: "fbh-actions" }, [attachButton, fileInput]);
  const replayToggle = el(doc, "input", {
    id: "fbh-no-replay",
    type: "checkbox",
    onChange: () => {
      includeReplay = !replayToggle.checked;
      renderNote();
    },
  });
  const submitButton = el(doc, "button", {
    id: "fbh-submit",
    type: "button",
    class: "fbh-primary",
    text: "Send report",
    onClick: () => {
      send();
    },
  });

  const element = el(doc, "section", { class: "fbh-form" }, [
    el(doc, "div", { class: "fbh-fields" }, [
      el(doc, "label", { class: "fbh-field" }, [
        el(doc, "span", { class: "fbh-label", text: "Section" }),
        sectionSelect,
      ]),
      el(doc, "label", { class: "fbh-field" }, [
        el(doc, "span", { class: "fbh-label", text: "Type" }),
        typeSelect,
      ]),
    ]),
    el(doc, "label", { class: "fbh-field" }, [
      el(doc, "span", { class: "fbh-label", text: "What happened" }),
      textarea,
    ]),
    strip,
    annotatorMount,
    actions,
    note,
    el(doc, "label", { class: "fbh-check" }, [
      replayToggle,
      el(doc, "span", { text: "Leave the recording out" }),
    ]),
    el(doc, "div", { class: "fbh-status-row" }, [message, retrySlot]),
    el(doc, "div", { class: "fbh-submit-row" }, [submitButton]),
  ]);

  function fill(select, values, chosen) {
    clear(select);
    for (const value of values) {
      select.appendChild(el(doc, "option", { value, text: value, selected: value === chosen }));
    }
    select.value = chosen;
  }

  function say(text) {
    message.textContent = text;
  }

  function objectUrl(blob) {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
    try {
      const url = URL.createObjectURL(blob);
      urls.push(url);
      return url;
    } catch {
      return "";
    }
  }

  function releaseUrls() {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      for (const url of urls) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // nothing to do
        }
      }
    }
    urls.length = 0;
  }

  function renderNote() {
    // No `dom`: the page copy was removed on 2026-09-21 (note at the top), and this line is what
    // the reporter reads before they send — it must name only what is really attached, never
    // something that is not. `describeAttachments` never took a `dom` argument to begin with any
    // more, so there is nothing here to withhold.
    //
    // The recording clause is driven by `replayAttached`, not the static `options.capture.replay`
    // flag: the flag only says the app asked for a recording, and stays true even where rrweb
    // never actually starts. `replayAttached` is the answer `api.replayReady` gave once it
    // settled, so the note can never promise a recording the bundle will not actually carry.
    note.textContent = describeAttachments({
      screenshot,
      replay: includeReplay && replayAttached ? true : null,
      images,
    });
  }

  // `api.replayReady` (see mount.js) settles once, to whatever the recorder's real outcome was.
  // Subscribing here, once, for the life of the form covers every prepare()/open() to come:
  // "not yet settled" and "settled false" both leave the note's recording clause out until this
  // resolves true, so a late "yes" is a single, honest, one-way correction — never a flip back to
  // "no", and never announced before it is real.
  if (api.replayReady && typeof api.replayReady.then === "function") {
    api.replayReady.then((ready) => {
      replayAttached = !!ready;
      renderNote();
    });
  }

  function thumbnail(blob, label, onRemove, onDraw, extra = {}) {
    const url = objectUrl(blob);
    const preview = url
      ? el(doc, "img", { class: "fbh-thumb-img", src: url, alt: label })
      : el(doc, "span", { class: "fbh-thumb-img", text: label });
    return el(doc, "figure", { class: "fbh-thumb", ...extra }, [
      preview,
      el(doc, "figcaption", { text: label }),
      el(doc, "button", {
        type: "button",
        class: "fbh-thumb-draw",
        "data-draw": true,
        "aria-label": `Draw on ${label}`,
        text: "✎",
        onClick: () => onDraw(blob),
      }),
      el(doc, "button", {
        type: "button",
        class: "fbh-thumb-remove",
        "data-remove": true,
        "aria-label": `Remove ${label}`,
        text: "✕",
        onClick: onRemove,
      }),
    ]);
  }

  // `renderStrip` rebuilds every thumbnail from scratch, so a button that was just activated does
  // not survive its own click — the DOM node under the reporter's focus is gone by the time this
  // function returns. `focus`, when given, says which control should get it back once the rebuild
  // is done: a bare number is the strip position a just-removed attachment used to hold (Remove,
  // unchanged since task 10); `{ index, selector }` generalises that to any button kind — used
  // after Draw-and-Save replaces a thumbnail's image in place (see annotate() below), so the
  // reporter keeps their place at the same Draw button rather than landing on <body> when the
  // dialog closes. Whatever now occupies that slot gets focus; the Attach control gets it when
  // nothing does (the position fell off the end). Omitted entirely on the calls that only add an
  // attachment: those have nothing to restore.
  function renderStrip(focus) {
    clear(strip);
    if (screenshot) {
      strip.appendChild(
        thumbnail(
          screenshot,
          "Screenshot",
          () => {
            screenshot = null;
            renderStrip(0);
          },
          (blob) =>
            annotate(blob, (flattened) => {
              const problem = drawProblem(flattened);
              if (problem) {
                say(problem);
                return;
              }
              screenshot = flattened;
              renderStrip({ index: 0, selector: "[data-draw]" });
            }),
        ),
      );
    }
    images.forEach((entry, index) => {
      const stripPosition = (screenshot ? 1 : 0) + index;
      strip.appendChild(
        thumbnail(
          entry.blob,
          `Image ${index + 1}`,
          () => {
            images.splice(index, 1);
            renderStrip(stripPosition);
          },
          (blob) => annotate(blob, (flattened) => replaceImage(entry.id, flattened)),
          { "data-image": entry.id },
        ),
      );
    });
    renderNote();
    if (focus !== undefined) {
      const { index, selector = "[data-remove]" } =
        typeof focus === "number" ? { index: focus } : focus;
      const controls = strip.querySelectorAll(selector);
      (controls[index] || attachButton).focus();
    }
  }

  // The editor takes over the form area while it is open: one image, one pen, and no way to submit
  // half-way through an annotation. `onClose` fires for Save, for Cancel, for Escape and for a
  // failure to read the image, so there is one place that puts the form back — including keyboard
  // focus, which the dialog's own removal from the DOM would otherwise drop to <body> (the same
  // class of regression task 10 fixed for Remove). A successful Save already gets its own focus
  // restoration from renderStrip() above (onDone runs before close(), so by the time this fires the
  // old Draw button is already disconnected and `stop` correctly leaves it alone); Cancel, Escape
  // and a load failure never touch the strip, so they need this to get back to where they started.
  async function annotate(blob, onDone) {
    const trigger = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    annotatorMount.hidden = false;
    element.classList.add("fbh-form-annotating");
    const stop = () => {
      activeAnnotator = null;
      annotatorMount.hidden = true;
      element.classList.remove("fbh-form-annotating");
      if (trigger && trigger.isConnected && typeof trigger.focus === "function") trigger.focus();
    };
    const annotator = await openAnnotator({
      doc,
      blob,
      mount: annotatorMount,
      onSave: (flattened) => onDone(flattened),
      onClose: stop,
    });
    // The form (and its annotate() caller) can be destroyed while loadImage() was still pending
    // above — destroy() only closes what activeAnnotator already points at, so a dialog that
    // finishes opening *after* destroy() ran would otherwise never be told to close at all.
    if (destroyed) {
      annotator.close(); // a no-op {element: null, close(){}} when it never opened, either way
      return;
    }
    if (!annotator.element) {
      stop();
      say("That image could not be opened for drawing.");
      return;
    }
    activeAnnotator = annotator;
  }

  function addImage(blob, name = "image.png") {
    const problem = attachProblem(blob);
    if (problem) {
      say(problem);
      return false;
    }
    if (images.length >= CAPS.images) {
      say("Six images is the most that can go with a report.");
      return false;
    }
    images.push({ id: `${Date.now()}-${images.length}`, blob, name });
    renderStrip();
    return true;
  }

  function replaceImage(id, blob) {
    const index = images.findIndex((one) => one.id === id);
    if (index === -1) return;
    // A drawing that comes back the wrong type or over the cap is discarded, not the image it was
    // drawn on: the original attachment stays exactly as it was, the same outcome annotate.js's
    // own save() already gives a canvas that cannot be flattened at all (see its `!flattened`
    // branch) — this only differs by which check refused it.
    const problem = drawProblem(blob);
    if (problem) {
      say(problem);
      return;
    }
    images[index].blob = blob;
    renderStrip({ index: (screenshot ? 1 : 0) + index, selector: "[data-draw]" });
  }

  function onFilesPicked() {
    for (const file of fileInput.files || []) addImage(file, file.name);
    fileInput.value = "";
  }

  function onPaste(event) {
    const data = event.clipboardData;
    if (!data || !data.items) return;
    for (const item of data.items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile ? item.getAsFile() : null;
      if (file) addImage(file, file.name || "pasted.png");
    }
  }

  function setBusy(value) {
    busy = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? "Sending…" : "Send report";
    // A screen reader that has already moved focus away from the message region still gets the
    // busy state through the accessibility tree: the whole form is usable and announced, not only
    // the live region's text.
    element.setAttribute("aria-busy", String(value));
  }

  function hideRetry() {
    // send() calls this as its very first step, including when it is the Retry button itself
    // that was just activated: clear() below removes whatever is focused inside retrySlot before
    // anything else happens, and an element removed from the document drops focus to <body> with
    // no further notice to a screen reader. Move focus to the status line first — it is about to
    // read "Sending…", so a keyboard reporter lands somewhere deliberate and announced, never on
    // nothing.
    if (retrySlot.contains(doc.activeElement)) message.focus();
    clear(retrySlot);
  }

  function showRetry() {
    // The form lives in a shadow root when the built-in panel hosts it, so doc.getElementById
    // would never find these: look inside our own subtree. hideRetry() always runs first (at the
    // top of send()), so this guard only matters if showRetry() is ever called on its own.
    if (retrySlot.querySelector("#fbh-retry")) return;
    retrySlot.appendChild(
      el(doc, "button", {
        id: "fbh-retry",
        type: "button",
        class: "fbh-ghost fbh-inline",
        text: "Retry",
        onClick: () => {
          send();
        },
      }),
    );
  }

  async function send() {
    if (busy) return;
    // Cleared unconditionally, before any message is shown: a stale Retry button next to
    // "Add a description before sending." would offer to retry a request that was never made.
    hideRetry();
    const text = textarea.value.trim();
    if (!text) {
      say("Add a description before sending.");
      textarea.focus();
      return;
    }
    setBusy(true);
    say("Sending…");
    const fields = {
      section: sectionSelect.value,
      type: typeSelect.value,
      text,
      images: images.map((one) => one.blob),
      includeReplay,
      screenshot,
    };
    try {
      const result = await api.submit(fields);
      const sent = {
        id: result.id,
        section: fields.section,
        type: fields.type,
        text,
        at: new Date().toISOString(),
      };
      reset();
      say(
        result.dropped && result.dropped.length
          ? `Sent. Left out: ${result.dropped.join(", ")}.`
          : "Sent.",
      );
      onSubmitted(sent);
    } catch (err) {
      // Every failure kind (a validation refusal, a 401, a 413, a rate limit, a 5xx, an offline
      // network) already comes through transport.js's own messageFor() as a sentence meant for a
      // reporter to read, never a bare status code; the form's only job here is to show it and let
      // the reporter try again with everything still in place.
      say(err && err.message ? err.message : "Couldn't send, retry.");
      showRetry();
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    textarea.value = "";
    images.length = 0;
    screenshot = null;
    releaseUrls();
    renderStrip();
  }

  async function prepare() {
    say("");
    hideRetry();
    fill(
      sectionSelect,
      options.sections,
      defaultSection(options.sections, safeCall(options.section, "", "section()")),
    );
    fill(typeSelect, options.types, options.types[0]);
    includeReplay = true;
    replayToggle.checked = false;
    if (screenCaptureSupported(win) && !element.querySelector("#fbh-capture")) {
      actions.insertBefore(
        el(doc, "button", {
          id: "fbh-capture",
          type: "button",
          class: "fbh-ghost",
          text: "Capture screen",
          onClick: async () => {
            let blob = null;
            try {
              blob = await captureScreen({ doc, win });
            } catch {
              // captureScreen never rejects by its own contract (src/capture/screen.js); this
              // only guards a caller-supplied override (the `captureScreen` constructor option).
            }
            if (blob) {
              addImage(blob, "capture.png");
            } else {
              // A denied and a dismissed picker both resolve to `null` here with no way for this
              // module to tell them apart (captureScreen's own contract collapses every failure
              // into the same result); every other add-or-remove path already says something, so
              // this one says the neutral, true thing rather than guessing which happened.
              say("Screen capture wasn't added.");
            }
          },
        }),
        fileInput,
      );
    }
    renderStrip();
    doc.addEventListener("paste", onPaste);
    pasting = true;
    // Retaken on every prepare(), not only when `screenshot` is still null: spec §5.4 says the
    // screenshot is "taken when the panel opens", and a reporter who opened, closed without
    // sending and reopened later is reporting on the page as it is NOW, not as it was at the
    // first open. A screenshot the reporter removed from the strip is deliberately not "sticky"
    // either — the next open offers a fresh one, which they can remove again if they want to.
    if (options.capture.screenshot) {
      screenshot = await api.captureScreenshot();
      renderStrip();
    }
  }

  function release() {
    if (!pasting) return;
    doc.removeEventListener("paste", onPaste);
    pasting = false;
  }

  function destroy() {
    destroyed = true;
    release();
    if (activeAnnotator) activeAnnotator.close();
    releaseUrls();
    element.remove();
  }

  return {
    element,
    prepare,
    release,
    destroy,
    addImage,
    replaceImage,
    focus: () => textarea.focus(),
  };
}
