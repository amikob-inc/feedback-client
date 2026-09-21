// "Capture screen" in the report form (spec §5.4): getDisplayMedia to a single still, never a
// video — the reporter picks a window or a screen, one frame is drawn to a canvas, and the tracks
// are stopped immediately so no sharing indicator lingers. The button is only shown where the API
// exists (spec §5.4), and a cancelled picker is an ordinary outcome, not an error: the whole
// function is one try/catch that resolves to `null` rather than ever rejecting, because standing
// rule 3 (task-10-brief) says none of getDisplayMedia missing, denied, or dismissed may throw out
// of the panel.
import { warnOnce } from "../warn.js";

export const FRAME_WAIT_MS = 200;

export function screenCaptureSupported(win) {
  const media = win && win.navigator && win.navigator.mediaDevices;
  return !!(media && typeof media.getDisplayMedia === "function");
}

export async function captureScreen({ doc, win, frameWaitMs = FRAME_WAIT_MS } = {}) {
  if (!screenCaptureSupported(win)) return null;
  let stream = null;
  try {
    stream = await win.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = doc.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // The first frame is not there the instant play() resolves.
    await new Promise((resolve) => setTimeout(resolve, frameWaitMs));

    const track = stream.getVideoTracks()[0];
    const settings = track && typeof track.getSettings === "function" ? track.getSettings() : {};
    const canvas = doc.createElement("canvas");
    canvas.width = settings.width || video.videoWidth || 0;
    canvas.height = settings.height || video.videoHeight || 0;
    const context = canvas.width && canvas.height ? canvas.getContext("2d") : null;
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.pause();
    video.srcObject = null;
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch (err) {
    // Covers a missing/denied/dismissed picker, a play() autoplay rejection, and a canvas that
    // refuses to export (toBlob absent or throwing) — every one of these is a `null` result, not
    // an exception the host page has to handle.
    warnOnce("screen capture", err);
    return null;
  } finally {
    // Stop every track whatever happened above, including on the success path: a still is all
    // this ever needed, and the browser's sharing indicator must not outlive the capture.
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
}
