// The DOM snapshot and the replay go up gzipped (spec §5.3). CompressionStream is in every
// browser the dashboards support, but it is absent in older WebViews and behind some strict
// privacy settings: there it returns null and the part is simply left out, which the hub and the
// panel both cope with. gzipSupported() only says the constructor exists — some hardened
// browsers ship it disabled, so gzip() itself is still wrapped: any failure, at construction or
// mid-stream, degrades to null exactly the same way an absent constructor does, once, with one
// warning.
import { warnOnce } from "../warn.js";

export function gzipSupported() {
  return typeof CompressionStream === "function";
}

export async function gzip(text) {
  if (!gzipSupported()) return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    const buffer = await new Response(stream).arrayBuffer();
    return new Blob([buffer], { type: "application/gzip" });
  } catch (err) {
    warnOnce("gzip", err);
    return null;
  }
}
