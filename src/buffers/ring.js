// A fixed-size buffer of the newest N entries. Pure: no DOM, no globals — every buffer in
// src/buffers/ is one of these plus a patch that feeds it.
import { byteLength } from "../bytes.js";

export class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    // O(size) on every push once full (splice shifts every remaining element down): fine at
    // N=200, but a much larger buffer reusing this file under heavier traffic should switch to a
    // real circular index instead of trimming the array from the front.
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
    return item;
  }

  toArray() {
    return this.items.slice();
  }

  clear() {
    this.items.length = 0;
  }

  get length() {
    return this.items.length;
  }
}

// Cuts on a real UTF-8 byte budget, not JS string .length (UTF-16 code units): the spec's "1 KB"
// (§5.2) and "512 KB" (§5.6) are both wire budgets, and CJK or emoji text can be 2-4x its
// code-unit count in bytes. Iterating by code point (not by UTF-16 unit) means a surrogate pair is
// always kept or dropped as a pair, so a cut can never leave half an emoji behind.
export function cut(text, max) {
  const value =
    typeof text === "string" ? text : text === undefined || text === null ? "" : String(text);
  if (byteLength(value) <= max) return value;
  let result = "";
  let bytes = 0;
  for (const ch of value) {
    // `for...of` over a string iterates by Unicode code point, so a surrogate pair moves as one.
    const chBytes = byteLength(ch);
    if (bytes + chBytes > max) break;
    result += ch;
    bytes += chBytes;
  }
  return result;
}
