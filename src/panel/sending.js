// The copy of the panel's "What will be sent" list: what each line says and how long a recording reads.
// Lives on the panel chunk, not in bundle.js, so the page load does not carry words only the panel shows.

// "1 min 43 s", "47 s", "2 min": the length of the recording as the reporter reads it.
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest} s`;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The "What will be sent" list (spec §5.4, owner's request 2026-09-30: a list, with counts): one
// line per thing that goes, in the order it is worth reading, and nothing for what does not go —
// except the log line, which is always there. The recording's line names the window it covers
// (the minute or two *before* the panel opened, mount.js) so the reporter knows what it shows;
// leaving it out is the form's business (the line stays put and is struck through), not this
// function's, which is why there is no "left out" wording here.
export function attachmentLines({
  screenshot = false,
  replay = null,
  images = 0,
  counts = {},
} = {}) {
  const lines = [];
  if (screenshot) {
    lines.push({
      key: "screenshot",
      text: "1 screenshot of this page, taken when you opened the panel",
    });
  }
  if (replay && replay.ready) {
    lines.push({
      key: "replay",
      text:
        typeof replay.seconds === "number"
          ? `The recording of the ${formatDuration(replay.seconds)} before you opened the panel`
          : "The recording (nothing recorded yet)",
    });
  }
  if (images > 0) lines.push({ key: "images", text: `${plural(images, "image")} you added` });
  const c = counts || {};
  lines.push({
    key: "logs",
    text:
      `The console and network log: ${plural(c.console || 0, "console line")}, ` +
      `${plural(c.errors || 0, "error")}, ${plural(c.network || 0, "failed or slow request")}, ` +
      `${plural(c.breadcrumbs || 0, "click")}`,
  });
  return lines;
}
