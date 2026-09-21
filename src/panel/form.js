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
import { clear, el } from "./dom.js";

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg"];

// Task-10-brief standing rule 3 ("the library may never break the host application"): an app's
// own `section()` hook is exactly the kind of callback that can throw for reasons outside this
// module's control. mount.js already guards every such hook with the same pattern (see its
// `safeCall`); this is that pattern's twin for the one app hook the form itself calls.
function safeCall(fn, fallback, label) {
  try {
    return fn();
  } catch (err) {
    warnOnce(label, err);
    return fallback;
  }
}

export function createForm({
  api,
  options,
  doc,
  win = doc.defaultView,
  onSubmitted = () => {},
  captureScreen = defaultCaptureScreen,
}) {
  let screenshot = null;
  let includeReplay = true;
  let busy = false;
  let pasting = false;
  const images = [];
  const urls = [];

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
  const note = el(doc, "p", { class: "fbh-note" });
  // aria-atomic: the whole line is replaced on every update (never a partial diff a reporter
  // could misread as the complete list of attachments), so a screen reader must announce it whole
  // too. role="status" + aria-live="polite" covers both the informational states (sending, sent,
  // left-out-on-submit) and the failure states (standing rule 1: every state must be announced,
  // not only shown in colour) without interrupting whatever the reporter is doing, the way an
  // assertive region would.
  const message = el(doc, "p", {
    class: "fbh-message",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
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
    // something that is not (task-10-brief standing rule 4). `describeAttachments` never took a
    // `dom` argument to begin with any more, so there is nothing here to withhold.
    note.textContent = describeAttachments({
      screenshot,
      replay: includeReplay && options.capture.replay ? true : null,
      images,
    });
  }

  function thumbnail(blob, label, onRemove, extra = {}) {
    const url = objectUrl(blob);
    const preview = url
      ? el(doc, "img", { class: "fbh-thumb-img", src: url, alt: label })
      : el(doc, "span", { class: "fbh-thumb-img", text: label });
    return el(doc, "figure", { class: "fbh-thumb", ...extra }, [
      preview,
      el(doc, "figcaption", { text: label }),
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

  function renderStrip() {
    clear(strip);
    if (screenshot) {
      strip.appendChild(
        thumbnail(screenshot, "Screenshot", () => {
          screenshot = null;
          renderStrip();
        }),
      );
    }
    images.forEach((entry, index) => {
      strip.appendChild(
        thumbnail(
          entry.blob,
          `Image ${index + 1}`,
          () => {
            images.splice(index, 1);
            renderStrip();
          },
          { "data-image": entry.id },
        ),
      );
    });
    renderNote();
  }

  function addImage(blob, name = "image.png") {
    if (!blob || !ACCEPTED_IMAGE_TYPES.includes(blob.type)) {
      say("Only PNG and JPEG images can be attached.");
      return false;
    }
    if (blob.size > CAPS.image) {
      say("That image is over 5 MB.");
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
    const entry = images.find((one) => one.id === id);
    if (!entry) return;
    entry.blob = blob;
    renderStrip();
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
    // busy state through the accessibility tree (standing rule 2: "the whole thing" usable and
    // announced, not only the live region's text).
    element.setAttribute("aria-busy", String(value));
  }

  function hideRetry() {
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
      // reporter to read, never a bare status code (standing rule 1); the form's only job here is
      // to show it and let the reporter try again with everything still in place.
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
            if (blob) addImage(blob, "capture.png");
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
    release();
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
