// The recording's preview (owner's request, 2026-09-30): the drawing dialog's sibling. A nested
// dialog inside the form that loads rrweb-player only now — the third lazily imported dependency,
// beside the recorder and the screenshot module — and plays exactly the events the report would
// carry (mount.js's frozen copy). The player's own controller is switched off: its stylesheet is
// Svelte-scoped and cannot be reproduced inside the shadow root, so the controls here are ours,
// styled like the rest of the panel: Play/Pause, the time, Close. Escape closes, like the
// annotator, and the panel's trap scopes Tab to this dialog while it is open (panel.js).
import { warnOnce } from "../warn.js";
import { el } from "./dom.js";

// "1:01 / 1:43"
export function clock(currentMs, totalMs) {
  const stamp = (ms) => {
    const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return `${stamp(currentMs)} / ${stamp(totalMs)}`;
}

export function openPreview({
  doc,
  mount,
  events,
  load = () => import("rrweb-player"),
  onClose = () => {},
}) {
  let player = null;
  let closed = false;

  const stage = el(doc, "div", { class: "fbh-preview-stage" });
  const status = el(doc, "p", {
    class: "fbh-preview-status",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
    text: "Loading the player…",
  });
  const time = el(doc, "span", { class: "fbh-preview-time", "aria-live": "off" });
  const playButton = el(doc, "button", {
    type: "button",
    class: "fbh-ghost",
    "data-play": true,
    text: "Pause",
    onClick: () => {
      if (player) player.toggle();
    },
  });
  const closeButton = el(doc, "button", {
    type: "button",
    class: "fbh-ghost",
    "data-preview-close": true,
    text: "Close",
    onClick: () => close(),
  });
  const element = el(
    doc,
    "div",
    {
      class: "fbh-preview",
      role: "dialog",
      "aria-label": "Preview of the recording",
      tabindex: "-1",
    },
    [
      stage,
      status,
      el(doc, "div", { class: "fbh-preview-actions" }, [playButton, time, closeButton]),
    ],
  );

  function onKeydown(event) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  function close() {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKeydown);
    if (player) {
      try {
        player.pause();
        player.$destroy();
      } catch (err) {
        warnOnce("preview close", err);
      }
      player = null;
    }
    element.remove();
    onClose();
  }

  doc.addEventListener("keydown", onKeydown);
  mount.appendChild(element);
  element.focus();

  (async () => {
    try {
      const module = await load();
      const Player = module.Player || module.default;
      if (typeof Player !== "function") throw new Error("rrweb-player exports no Player");
      if (closed) return;
      // The stage's box decides the player's size; the player scales the recorded viewport to
      // fit it. Fallbacks for an environment with no layout.
      const rect = stage.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width) || 800);
      const height = Math.max(240, Math.floor(rect.height) || Math.round(width * 0.62));
      player = new Player({
        target: stage,
        props: {
          // Shallow copies: rrweb's Replayer writes `delay` onto every event object it is given,
          // and these objects are the frozen copy's own, shared with the live segments — handed
          // over as they are, a preview would add a field to every event the report then sends.
          events: events.map((event) => ({ ...event })),
          width,
          height,
          autoPlay: true,
          showController: false,
          skipInactive: true,
        },
      });
      const total = () => {
        try {
          return player.getMetaData().totalTime;
        } catch {
          return 0;
        }
      };
      player.addEventListener("ui-update-current-time", (event) => {
        time.textContent = clock(event && event.payload, total());
      });
      player.addEventListener("ui-update-player-state", (event) => {
        playButton.textContent = event && event.payload === "playing" ? "Pause" : "Play";
      });
      time.textContent = clock(0, total());
      status.textContent = "";
    } catch (err) {
      warnOnce("preview", err);
      if (!closed) status.textContent = "The player could not be loaded. Close this and try again.";
    }
  })();

  return { element, close };
}
