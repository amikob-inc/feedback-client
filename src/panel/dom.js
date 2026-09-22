// The panel builds its DOM with these four helpers and never with innerHTML: a report's own text,
// a reporter's name and the AI's answer all end up on screen, and none of them may be parsed as
// markup. `text` always goes through textContent.
export function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

// Which element inside `node` holds keyboard focus, or null. `document.activeElement` is the
// wrong question once the panel is inside a shadow root: it answers with the *host* element,
// whatever is focused within the shadow tree, so `node.contains(document.activeElement)` is false
// however deep inside `node` the focus really is — and every guard written that way quietly stops
// working in the built-in panel while still passing in a test that mounts the same component
// straight into the document. `getRootNode()` returns whichever root this subtree actually lives
// in, shadow or document, and both kinds answer `activeElement` about their own tree.
export function activeWithin(node) {
  const root = node && typeof node.getRootNode === "function" ? node.getRootNode() : null;
  const active = root && root.activeElement;
  return active && node.contains(active) ? active : null;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function firstLine(text, max = 120) {
  const line = String(text || "")
    .split("\n")[0]
    .trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function relativeTime(iso, now = new Date()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toISOString().slice(0, 10);
}
