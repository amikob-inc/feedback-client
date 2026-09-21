// The automatic screenshot (spec §5.3): modern-screenshot's domToBlob, imported only when a
// screenshot is actually taken. Two things beyond the spec's literal call: the panel's own host
// element is filtered out (it is on the page by the time the panel asks for a capture, and a
// screenshot of the report form helps nobody), and a capture over the hub's 5 MB cap is dropped
// here rather than rejected there. A failed capture is never fatal (spec §5.8).
import { warnOnce } from "../warn.js";

export const SCREENSHOT_MAX = 5 * 1024 * 1024;
export const HOST_ID = "fbh-host";

export async function captureScreenshot({
  load = () => import("modern-screenshot"),
  target = document.body,
  hostId = HOST_ID,
} = {}) {
  try {
    const { domToBlob } = await load();
    const blob = await domToBlob(target, {
      scale: 1,
      timeout: 5000,
      filter: (node) => !(node && node.nodeType === 1 && node.id === hostId),
    });
    if (!blob) return null;
    if (blob.size > SCREENSHOT_MAX) {
      warnOnce("screenshot", new Error(`the capture is ${blob.size} bytes, over the 5 MB cap`));
      return null;
    }
    return blob;
  } catch (err) {
    warnOnce("screenshot", err);
    return null;
  }
}
