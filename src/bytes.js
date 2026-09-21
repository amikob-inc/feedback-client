// UTF-8 byte length of a string. The spec's per-entry and whole-report budgets (§5.2, §5.6) are
// wire budgets in bytes, not JS string .length (UTF-16 code units) — non-Latin text can be 2-4x
// its code-unit count once encoded.
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}
