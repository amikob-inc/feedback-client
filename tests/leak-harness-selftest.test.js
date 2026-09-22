/** @vitest-environment jsdom */
// Can the harness go red?
//
// A green harness that cannot fail proves nothing, and the matrix in tests/leak-matrix.test.js is
// green. So this file makes it fail on purpose, twice over: once against a bundle built by hand,
// where the answer is known exactly, and once against a real capture run where a position is
// declared `withheld` although the recording really does carry it. The second is the one that
// matters — it proves the harness detects a marker that genuinely reached the outgoing FormData,
// and that what it prints names the position and shows the text around the hit.
//
// The same two tests are what catches the harness being wired to nothing: if `runCapture` ever
// stopped producing a bundle, or `scan` stopped searching it, the live test below would go green
// where it is asserted red.
import { describe, expect, it } from "vitest";
import { formatScan, runCapture, scan } from "./lib/capture-harness.js";

const SETTINGS = { maskAllInputs: true, blank: [".fbh-blank"], replay: true, screenshot: false };

function fakeParts(text) {
  return [
    { name: "report", encoding: "json", bytes: text.length, text },
    { name: "replay", encoding: "gzip+json", bytes: 0, text: "[]" },
  ];
}

describe("scan, against a bundle built by hand", () => {
  it("reports a marker that reached a part it should have been withheld from", () => {
    const marker = "FBHMKSELFX001XPLANTED";
    const position = {
      id: "selftest/planted",
      group: "selftest",
      zone: "sensitive",
      kind: "text",
      where: "a hand-built report part",
    };
    const parts = fakeParts(`{"text":"before ${marker} after"}`);
    const result = scan({ parts, registry: new Map([[marker, position]]), settings: SETTINGS });

    expect(result.leaked).toHaveLength(1);
    expect(result.leaked[0].position.id).toBe("selftest/planted");
    expect(result.leaked[0].hits[0].part).toBe("report");
    expect(result.leaked[0].hits[0].context).toContain(`before ${marker} after`);

    const printed = formatScan(result, { title: "selftest" });
    expect(printed).toContain("1 leaked");
    expect(printed).toContain("LEAK  selftest/planted");
    expect(printed).toContain(marker);
    expect(printed).toContain("found in report at byte");
  });

  it("reports a marker that should have been sent and was not", () => {
    const marker = "FBHMKSELFX002XABSENT";
    const position = {
      id: "selftest/absent",
      group: "selftest",
      zone: "ordinary",
      kind: "text",
      where: "a hand-built report part that does not contain it",
    };
    const result = scan({
      parts: fakeParts('{"text":"nothing here"}'),
      registry: new Map([[marker, position]]),
      settings: SETTINGS,
    });

    expect(result.leaked).toEqual([]);
    expect(result.missing.map((one) => one.position.id)).toEqual(["selftest/absent"]);
    expect(formatScan(result, { title: "selftest" })).toContain("MISSING  selftest/absent");
  });

  it("finds a marker in a binary part, not only in the JSON", () => {
    const marker = "FBHMKSELFX003XINBYTES";
    const position = { id: "selftest/bytes", zone: "sensitive", kind: "text", where: "an image" };
    const parts = [
      { name: "report", encoding: "json", bytes: 2, text: "{}" },
      { name: "image", encoding: "binary", bytes: 40, text: `\x89PNG\r\n\x1a\ntEXt\0${marker}` },
    ];
    const result = scan({ parts, registry: new Map([[marker, position]]), settings: SETTINGS });
    expect(result.leaked.map((one) => one.hits[0].part)).toEqual(["image"]);
  });
});

describe("the harness against a real capture run", () => {
  // One ordinary text node, which the recording really does carry. It is declared `password`,
  // which makes its fate "withheld under every setting" — so the harness has to report it. The
  // lie is in the declaration, not in the library: nothing about the capture path is weakened to
  // produce the failure, and the control position beside it is the same text node declared
  // honestly, which must still come through.
  const lying = {
    id: "selftest/live-text",
    group: "selftest",
    zone: "ordinary",
    kind: "password",
    where: "a text node in ordinary page content, deliberately declared as a password",
    plant: (ctx) => {
      const el = ctx.doc.createElement("p");
      el.textContent = `Cost GBP 1,240 ${ctx.marker}`;
      ctx.parent.appendChild(el);
    },
  };
  const honest = {
    ...lying,
    id: "selftest/live-control",
    kind: "text",
    where: "the same text node, declared honestly",
  };

  it("goes red on a marker the recording really carries, and says where", async () => {
    const result = scan(
      await runCapture({ settings: SETTINGS, positions: [lying, honest], interact: false }),
    );

    const leaked = result.leaked.map((one) => one.position.id);
    expect(leaked).toEqual(["selftest/live-text"]);
    expect(result.missing).toEqual([]);

    const hit = result.leaked[0].hits[0];
    expect(hit.part).toBe("replay");
    expect(hit.context).toContain("Cost GBP 1,240");
    expect(typeof hit.at).toBe("number");

    const printed = formatScan(result, { title: "selftest live" });
    expect(printed).toContain("LEAK  selftest/live-text");
    expect(printed).toContain("deliberately declared as a password");
    expect(printed).toContain("found in replay at byte");
  }, 60000);
});
