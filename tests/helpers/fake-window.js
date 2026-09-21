// A minimal event target with the few window fields the buffers read. The buffer tests run in
// plain Node on purpose: nothing in src/buffers/ may need a real DOM.
export function createFakeWindow({ href = "https://app.example/rings" } = {}) {
  const listeners = new Map();
  const win = {
    listeners,
    location: new URL(href),
    history: { pushState() {}, replaceState() {} },
    addEventListener(type, fn, options) {
      const key = `${type}:${options === true || (options && options.capture) ? "capture" : "bubble"}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
    },
    removeEventListener(type, fn, options) {
      const key = `${type}:${options === true || (options && options.capture) ? "capture" : "bubble"}`;
      const set = listeners.get(key);
      if (set) set.delete(fn);
    },
    dispatch(type, event = {}) {
      for (const phase of ["capture", "bubble"]) {
        const set = listeners.get(`${type}:${phase}`);
        if (set) for (const fn of [...set]) fn({ type, ...event });
      }
    },
    countListeners() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
  return win;
}
