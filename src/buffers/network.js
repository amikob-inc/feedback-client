// The network buffer (spec §5.2): the last 50 requests that failed, answered 400 or worse, or took
// longer than three seconds. Never a header, never a body, and never a query string (spec §5.7) —
// `scrubUrl` keeps the origin and the path and throws the rest away before anything is stored.
import { Ring } from "./ring.js";
import { warnOnce } from "../warn.js";

export const NETWORK_KEEP = 50;
export const SLOW_MS = 3000;
const META = "__fbhRequest";

export function scrubUrl(raw, base) {
  const text = raw === undefined || raw === null ? "" : String(raw);
  try {
    const url = new URL(text, base);
    return `${url.origin}${url.pathname}`;
  } catch {
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
  clock = () => Date.now(),
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
  if (typeof originalFetch === "function") {
    target.fetch = function patchedFetch(input, init) {
      const started = clock();
      const t = now();
      const method = String(
        (init && init.method) || (input && input.method) || "GET",
      ).toUpperCase();
      const url = scrubUrl(input && input.url ? input.url : input, base);
      return originalFetch.call(this, input, init).then(
        (res) => {
          record({
            t,
            method,
            url,
            status: res ? res.status : 0,
            ms: clock() - started,
            failed: false,
          });
          return res;
        },
        (err) => {
          record({ t, method, url, status: 0, ms: clock() - started, failed: true });
          throw err;
        },
      );
    };
  }

  const Xhr = target.XMLHttpRequest;
  const originalOpen = Xhr && Xhr.prototype && Xhr.prototype.open;
  const originalSend = Xhr && Xhr.prototype && Xhr.prototype.send;
  if (originalOpen && originalSend) {
    Xhr.prototype.open = function patchedOpen(method, url, ...rest) {
      this[META] = { method: String(method || "GET").toUpperCase(), url: scrubUrl(url, base) };
      return originalOpen.call(this, method, url, ...rest);
    };
    Xhr.prototype.send = function patchedSend(...args) {
      const meta = this[META];
      if (meta) {
        const started = clock();
        const t = now();
        this.addEventListener("loadend", () => {
          const status = Number(this.status) || 0;
          record({
            t,
            method: meta.method,
            url: meta.url,
            status,
            ms: clock() - started,
            failed: status === 0,
          });
        });
      }
      return originalSend.apply(this, args);
    };
  }

  return {
    entries: () => ring.toArray(),
    uninstall() {
      if (typeof originalFetch === "function") target.fetch = originalFetch;
      if (originalOpen && originalSend) {
        Xhr.prototype.open = originalOpen;
        Xhr.prototype.send = originalSend;
      }
    },
  };
}
