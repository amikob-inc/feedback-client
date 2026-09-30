import { describe, expect, it } from "vitest";
import { attachmentLines, formatDuration } from "../src/panel/sending.js";

describe("formatDuration", () => {
  it("says seconds under a minute, minutes and seconds above, whole minutes plainly", () => {
    expect(formatDuration(47)).toBe("47 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(103)).toBe("1 min 43 s");
    expect(formatDuration(120.4)).toBe("2 min");
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(-3)).toBe("0 s");
    expect(formatDuration(undefined)).toBe("0 s");
  });
});

describe("attachmentLines", () => {
  const counts = { console: 12, errors: 1, network: 3, breadcrumbs: 40 };
  const logs =
    "The console and network log: 12 console lines, 1 error, 3 failed or slow requests, 40 clicks";

  it("lists everything that goes, one line each, in order, with counts", () => {
    expect(
      attachmentLines({
        screenshot: true,
        replay: { ready: true, seconds: 103 },
        images: 2,
        counts,
      }),
    ).toEqual([
      { key: "screenshot", text: "1 screenshot of this page, taken when you opened the panel" },
      { key: "replay", text: "The recording of the 1 min 43 s before you opened the panel" },
      { key: "images", text: "2 images you added" },
      { key: "logs", text: logs },
    ]);
  });

  it("says one image in the singular, and leaves out what is not going", () => {
    expect(
      attachmentLines({ screenshot: false, replay: { ready: false }, images: 1, counts }),
    ).toEqual([
      { key: "images", text: "1 image you added" },
      { key: "logs", text: logs },
    ]);
  });

  it("names a recording that has not captured anything yet", () => {
    expect(attachmentLines({ replay: { ready: true, seconds: null }, counts })).toEqual([
      { key: "replay", text: "The recording (nothing recorded yet)" },
      { key: "logs", text: logs },
    ]);
  });

  it("counts in the plural and the singular, and copes with nothing at all", () => {
    expect(attachmentLines({})).toEqual([
      {
        key: "logs",
        text: "The console and network log: 0 console lines, 0 errors, 0 failed or slow requests, 0 clicks",
      },
    ]);
    expect(
      attachmentLines({ counts: { console: 1, errors: 2, network: 1, breadcrumbs: 1 } })[0].text,
    ).toBe(
      "The console and network log: 1 console line, 2 errors, 1 failed or slow request, 1 click",
    );
  });
});
