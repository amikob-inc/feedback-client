// One warning per subsystem, ever (spec §5.8): a patch that throws falls back to the original
// function and the library says so once, never once per call. `warn` is injectable because the
// console buffer must warn through the *original* console.warn, not through its own patch.
const warned = new Set();

export function warnOnce(label, err, warn = console.warn) {
  if (warned.has(label)) return;
  warned.add(label);
  const reason = err && err.message ? err.message : String(err);
  try {
    warn(`[feedback-client] ${label} disabled: ${reason}`);
  } catch {
    // A console that throws is not a reason to break the host app.
  }
}

// Tests only: the set is process-wide, so a test that asserts a warning has to clear it first.
export function resetWarnings() {
  warned.clear();
}
