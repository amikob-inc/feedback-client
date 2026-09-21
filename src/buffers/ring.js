// A fixed-size buffer of the newest N entries. Pure: no DOM, no globals — every buffer in
// src/buffers/ is one of these plus a patch that feeds it.
export class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
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

export function cut(text, max) {
  const value =
    typeof text === "string" ? text : text === undefined || text === null ? "" : String(text);
  return value.length <= max ? value : value.slice(0, max);
}
