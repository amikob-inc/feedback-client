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

export function rrwebOptions({ maskAllInputs = false, blank = [] } = {}, emit) {
  const options = {
    emit,
    checkoutEveryNms: CHECKOUT_MS,
    maskInputOptions: { password: true },
    maskAllInputs: !!maskAllInputs,
    sampling: { ...SAMPLING },
    recordCanvas: false,
  };
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
          rrwebOptions(capture, (event, isCheckout) => segments.push(event, !!isCheckout)),
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
