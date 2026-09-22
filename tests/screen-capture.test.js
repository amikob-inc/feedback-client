import { describe, expect, it, vi } from "vitest";
import { captureScreen, screenCaptureSupported } from "../src/capture/screen.js";
import { resetWarnings } from "../src/warn.js";

function fakeEnvironment({ getDisplayMedia, context = {} } = {}) {
  const stopped = [];
  const track = {
    getSettings: () => ({ width: 800, height: 600 }),
    stop: () => stopped.push("video"),
  };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage, ...context }),
    toBlob: (cb) => cb(new Blob([new Uint8Array(3)], { type: "image/png" })),
  };
  const video = {
    play: async () => {},
    pause: () => {},
    srcObject: null,
    videoWidth: 0,
    videoHeight: 0,
  };
  const doc = { createElement: (tag) => (tag === "canvas" ? canvas : video) };
  const win = {
    navigator: {
      mediaDevices: { getDisplayMedia: getDisplayMedia || (async () => stream) },
    },
  };
  return { doc, win, canvas, drawImage, stopped };
}

describe("screenCaptureSupported", () => {
  it("is false without the API", () => {
    expect(screenCaptureSupported({ navigator: {} })).toBe(false);
    expect(screenCaptureSupported({ navigator: { mediaDevices: {} } })).toBe(false);
    expect(screenCaptureSupported({ navigator: { mediaDevices: { getDisplayMedia() {} } } })).toBe(
      true,
    );
  });

  it("is false with no window at all, rather than throwing", () => {
    expect(screenCaptureSupported(undefined)).toBe(false);
    expect(screenCaptureSupported(null)).toBe(false);
  });
});

describe("captureScreen", () => {
  it("draws one frame at the track's size, returns a PNG and stops the stream", async () => {
    const env = fakeEnvironment();
    const blob = await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 });
    expect(blob.type).toBe("image/png");
    expect(env.canvas.width).toBe(800);
    expect(env.canvas.height).toBe(600);
    expect(env.drawImage).toHaveBeenCalledTimes(1);
    expect(env.stopped).toEqual(["video"]);
  });

  it("is null when the reporter cancels the picker, and the warning is not repeated", async () => {
    resetWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = fakeEnvironment({
      getDisplayMedia: async () => {
        throw new Error("Permission denied");
      },
    });
    expect(await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).toBe(null);
    expect(await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).toBe(null);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is null where the API does not exist", async () => {
    expect(await captureScreen({ doc: {}, win: { navigator: {} }, frameWaitMs: 0 })).toBe(null);
  });

  it("is null, and still stops the stream, when the picked source has no usable size", async () => {
    const env = fakeEnvironment();
    const track = {
      getSettings: () => ({ width: 0, height: 0 }),
      stop: () => env.stopped.push("video"),
    };
    env.win.navigator.mediaDevices.getDisplayMedia = async () => ({
      getVideoTracks: () => [track],
      getTracks: () => [track],
    });
    expect(await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).toBe(null);
    expect(env.stopped).toEqual(["video"]);
  });

  it("is null, and still stops the stream, when the canvas refuses a 2D context", async () => {
    const env = fakeEnvironment();
    env.canvas.getContext = () => null;
    expect(await captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).toBe(null);
    expect(env.stopped).toEqual(["video"]);
  });

  it("is null, not thrown, when the canvas cannot export a blob", async () => {
    const env = fakeEnvironment();
    env.canvas.toBlob = () => {
      throw new Error("toBlob unsupported");
    };
    await expect(captureScreen({ doc: env.doc, win: env.win, frameWaitMs: 0 })).resolves.toBe(null);
    expect(env.stopped).toEqual(["video"]);
  });
});
