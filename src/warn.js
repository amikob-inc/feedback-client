// One warning per subsystem, ever (spec §5.8): a patch that throws falls back to the original
// function and the library says so once, never once per call. `warn` is injectable because the
// console buffer must warn through the *original* console.warn, not through its own patch.
const warned = new Set();

// One line per label, whatever the sentence. `warnOnce` is the "something broke and we carried
// on" spelling; `noticeOnce` is for the cases where nothing is disabled and saying so would be a
// lie — an app's mistake that this library worked around, for instance.
function once(label, line, warn) {
  if (warned.has(label)) return;
  warned.add(label);
  try {
    warn(`[feedback-client] ${line}`);
  } catch {
    // A console that throws is not a reason to break the host app.
  }
}

export function noticeOnce(label, message, warn = console.warn) {
  once(label, `${label}: ${message}`, warn);
}

export function warnOnce(label, err, warn = console.warn) {
  once(label, `${label} disabled: ${err && err.message ? err.message : String(err)}`, warn);
}

// Tests only: the set is process-wide, so a test that asserts a warning has to clear it first.
export function resetWarnings() {
  warned.clear();
}
