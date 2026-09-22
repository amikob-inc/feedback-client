// What the reporter has already seen, per reporter, in localStorage (spec §5.4). It decides the
// topbar dot: a report needs attention when the AI is waiting for an answer, or when it answered
// since the last time this reporter looked. Storage can be absent, full or blocked (private
// windows, strict settings), and none of that may cost the panel anything.
export const SEEN_PREFIX = "fbh.seen";
export const SEEN_CAP = 200;

export function seenKey(app, reporterId) {
  return `${SEEN_PREFIX}.${app}.${reporterId || "anon"}`;
}

export function safeStorage(win) {
  try {
    const storage = win.localStorage;
    storage.getItem(`${SEEN_PREFIX}.probe`);
    return storage;
  } catch {
    return null;
  }
}

export function readSeen(storage, key) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSeen(storage, key, seen) {
  if (!storage) return;
  try {
    const entries = Object.entries(seen).slice(-SEEN_CAP);
    storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // A full or blocked storage costs the dot its memory, nothing more.
  }
}

export function attentionIds(items, seen = {}) {
  const ids = [];
  for (const item of items) {
    if (item.status === "needs_reply") {
      ids.push(item.id);
      continue;
    }
    const at = item.verdict && item.verdict.receivedAt;
    if (item.status === "answered" && at && seen[item.id] !== at) ids.push(item.id);
  }
  return ids;
}

export function markSeen(seen, items) {
  const next = { ...seen };
  let changed = false;
  for (const item of items) {
    const at = item.verdict && item.verdict.receivedAt;
    if (at && next[item.id] !== at) {
      next[item.id] = at;
      changed = true;
    }
  }
  return { seen: next, changed };
}
