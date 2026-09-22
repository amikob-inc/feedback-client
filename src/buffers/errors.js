// The error buffer (spec §5.2): the last 20 uncaught errors and unhandled rejections, message and
// stack. The `error` listener is deliberately not a capturing one — a capturing listener also
// catches every failed image or stylesheet load, which is noise the triage run does not need.
import { Ring } from "./ring.js";
import { warnOnce } from "../warn.js";

export const ERRORS_KEEP = 20;

export function describeErrorEvent(event) {
  const err = event && (event.error || event.reason);
  if (err instanceof Error) {
    return {
      message: err.message || String(err),
      stack: typeof err.stack === "string" ? err.stack : "",
    };
  }
  if (err !== undefined && err !== null) return { message: String(err), stack: "" };
  return { message: (event && event.message) || "Unknown error", stack: "" };
}

export function installErrorBuffer({ target = window, now = () => new Date().toISOString() } = {}) {
  const ring = new Ring(ERRORS_KEEP);
  const onEvent = (event) => {
    try {
      const { message, stack } = describeErrorEvent(event);
      ring.push({ t: now(), message, stack });
    } catch (err) {
      warnOnce("error buffer", err);
    }
  };

  target.addEventListener("error", onEvent);
  target.addEventListener("unhandledrejection", onEvent);

  return {
    entries: () => ring.toArray(),
    uninstall() {
      target.removeEventListener("error", onEvent);
      target.removeEventListener("unhandledrejection", onEvent);
    },
  };
}
