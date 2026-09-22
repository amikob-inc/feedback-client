// The network buffer (spec §5.2): the last 50 requests that failed, answered 400 or worse, or took
// longer than three seconds. Never a header, never a body, and never a query string (spec §5.7) —
// `scrubUrl` keeps the origin and the path and throws the rest away before anything is stored.
import { Ring } from "./ring.js";
import { warnOnce } from "../warn.js";

export const NETWORK_KEEP = 50;
export const SLOW_MS = 3000;
const META = "__fbhRequest";

// `performance.now()` is monotonic; `Date.now()` is wall-clock and can jump (NTP sync, a user
// changing the system clock) mid-request. `ms` is the only signal `shouldRecord` uses for the
// "slower than 3 s" rule, so a wall-clock adjustment must not be able to corrupt it. Only fall
// back to `Date.now()` where `performance` genuinely is not available.
const defaultClock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export function scrubUrl(raw, base) {
  const text = raw === undefined || raw === null ? "" : String(raw);
  try {
    const url = new URL(text, base);
    // data: and blob: URLs are not "origin + path" shaped. A data: URL's pathname IS its payload
    // (the base64/percent-encoded content itself), and url.origin for one is the literal string
    // "null" — neither is safe or useful to keep. A blob: URL's pathname is a second, nested URL,
    // not a normal path, so origin+pathname would concatenate two URLs together. Keep only the
    // scheme (plus the blob's real origin, which url.origin does parse out correctly) — enough to
    // say "a data: request" or "a blob: request" happened, never the content.
    if (url.protocol === "data:") return "data:";
    if (url.protocol === "blob:") return `blob:${url.origin}`;
    return `${url.origin}${url.pathname}`;
  } catch {
    // Not parseable at all (no base and not an absolute URL). Best effort: cut before the first
    // ? or # so a query string or fragment can't survive even when nothing here could be parsed
    // as a real URL. installNetworkBuffer always supplies a base when the target has a location,
    // so in practice this only runs for a target without one, or a direct call to the exported
    // function with no base.
    const cutAt = text.search(/[?#]/);
    return cutAt === -1 ? text : text.slice(0, cutAt);
  }
}

export function shouldRecord({ status = 0, ms = 0, failed = false }) {
  return failed || status >= 400 || ms > SLOW_MS;
}

export function installNetworkBuffer({
  target = window,
  now = () => new Date().toISOString(),
  clock = defaultClock,
} = {}) {
  const ring = new Ring(NETWORK_KEEP);
  const base = target.location ? String(target.location) : undefined;

  const record = (entry) => {
    try {
      if (!shouldRecord(entry)) return;
      ring.push({
        t: entry.t,
        method: entry.method,
        url: entry.url,
        status: entry.status,
        ms: entry.ms,
      });
    } catch (err) {
      warnOnce("network buffer", err);
    }
  };

  const originalFetch = target.fetch;
  let patchedFetch;
  if (typeof originalFetch === "function") {
    patchedFetch = function (input, init) {
      // Everything this patch computes about the request — method, scrubbed URL, start time —
      // happens before the real fetch goes out, so none of it may be allowed to stop that fetch.
      // An unusual or hostile `input` (a `toString()` that throws, say) must still reach
      // `originalFetch` with the exact arguments the caller passed, untouched.
      let meta = null;
      try {
        const started = clock();
        const t = now();
        const method = String(
          (init && init.method) || (input && input.method) || "GET",
        ).toUpperCase();
        const url = scrubUrl(input && input.url ? input.url : input, base);
        meta = { started, t, method, url };
      } catch (err) {
        warnOnce("network buffer", err);
      }
      if (!meta) return originalFetch.call(this, input, init);
      return originalFetch.call(this, input, init).then(
        (res) => {
          record({
            t: meta.t,
            method: meta.method,
            url: meta.url,
            status: res ? res.status : 0,
            ms: clock() - meta.started,
            failed: false,
          });
          return res;
        },
        (err) => {
          record({
            t: meta.t,
            method: meta.method,
            url: meta.url,
            status: 0,
            ms: clock() - meta.started,
            failed: true,
          });
          throw err;
        },
      );
    };
    target.fetch = patchedFetch;
  }

  const Xhr = target.XMLHttpRequest;
  const originalOpen = Xhr && Xhr.prototype && Xhr.prototype.open;
  const originalSend = Xhr && Xhr.prototype && Xhr.prototype.send;
  let patchedOpen;
  let patchedSend;
  if (originalOpen && originalSend) {
    patchedOpen = function (method, url, ...rest) {
      try {
        this[META] = { method: String(method || "GET").toUpperCase(), url: scrubUrl(url, base) };
      } catch (err) {
        this[META] = null;
        warnOnce("network buffer", err);
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    patchedSend = function (...args) {
      try {
        const meta = this[META];
        if (meta) {
          const started = clock();
          const t = now();
          const onLoadEnd = () => {
            // Self-removing. One XMLHttpRequest instance reopened for a second request is a
            // common pattern; without this, a second send() adds a second "loadend" listener
            // without removing the first, and when the request finishes both listeners read the
            // *live* this.status against their own (different) captured url/method — mixing one
            // request's address into another request's outcome. Removing itself the moment it
            // fires means at most one of our listeners is ever attached at a time, so a reopen
            // can't corrupt an earlier or later entry.
            this.removeEventListener("loadend", onLoadEnd);
            try {
              const status = Number(this.status) || 0;
              record({
                t,
                method: meta.method,
                url: meta.url,
                status,
                ms: clock() - started,
                failed: status === 0,
              });
            } catch (err) {
              warnOnce("network buffer", err);
            }
          };
          this.addEventListener("loadend", onLoadEnd);
        }
      } catch (err) {
        warnOnce("network buffer", err);
      }
      return originalSend.apply(this, args);
    };
    Xhr.prototype.open = patchedOpen;
    Xhr.prototype.send = patchedSend;
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      // Restore only the layer this instance installed. If the app (or another library) patched
      // fetch or XMLHttpRequest again after we did, that patch is not ours to discard — same rule
      // as the console buffer's uninstall.
      if (typeof originalFetch === "function" && target.fetch === patchedFetch) {
        target.fetch = originalFetch;
      }
      if (originalOpen && originalSend) {
        if (Xhr.prototype.open === patchedOpen) Xhr.prototype.open = originalOpen;
        if (Xhr.prototype.send === patchedSend) Xhr.prototype.send = originalSend;
      }
    },
  };
}
