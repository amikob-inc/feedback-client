import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPTURE,
  DEFAULT_TYPES,
  OptionError,
  defaultSection,
  normalizeOptions,
} from "../src/options.js";

const base = { app: "cad", hubUrl: "https://hub.example", getToken: async () => "t" };

describe("normalizeOptions", () => {
  it("throws on an option it does not know, naming it", () => {
    expect(() => normalizeOptions({ ...base, hubURL: "x" })).toThrow(OptionError);
    expect(() => normalizeOptions({ ...base, hubURL: "x" })).toThrow(/unknown option "hubURL"/);
  });

  it("throws on an unknown capture key", () => {
    expect(() => normalizeOptions({ ...base, capture: { relpay: true } })).toThrow(
      /unknown capture option "relpay"/,
    );
  });

  it("requires app", () => {
    expect(() => normalizeOptions({ hubUrl: "https://h", getToken: async () => "t" })).toThrow(
      /"app"/,
    );
  });

  it("requires getToken when there is a hub", () => {
    expect(() => normalizeOptions({ app: "cad", hubUrl: "https://h" })).toThrow(/"getToken"/);
  });

  it("allows a missing getToken when the feature is off", () => {
    expect(normalizeOptions({ app: "cad" }).hubUrl).toBe("");
  });

  it("trims trailing slashes off the hub URL", () => {
    expect(normalizeOptions({ ...base, hubUrl: "https://hub.example//" }).hubUrl).toBe(
      "https://hub.example",
    );
  });

  it("fills in the defaults the spec names", () => {
    const options = normalizeOptions(base);
    expect(options.types).toEqual(DEFAULT_TYPES);
    expect(options.sections).toEqual(["General"]);
    expect(options.capture).toEqual(DEFAULT_CAPTURE);
    expect(options.theme()).toBe("light");
    expect(options.user()).toBe(null);
    expect(options.section()).toBe("");
  });

  it("keeps the app's own lists and capture switches", () => {
    const options = normalizeOptions({
      ...base,
      sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
      types: ["Bug", "Question"],
      capture: { replay: false, blank: [".sku-price"] },
    });
    expect(options.sections).toHaveLength(4);
    expect(options.types).toEqual(["Bug", "Question"]);
    expect(options.capture.replay).toBe(false);
    expect(options.capture.screenshot).toBe(true);
    expect(options.capture.blank).toEqual([".sku-price"]);
  });

  it("rejects a list that is not strings and a hook that is not a function", () => {
    expect(() => normalizeOptions({ ...base, sections: "General" })).toThrow(/"sections"/);
    expect(() => normalizeOptions({ ...base, types: [1] })).toThrow(/"types"/);
    expect(() => normalizeOptions({ ...base, theme: "dark" })).toThrow(/"theme"/);
    expect(() => normalizeOptions({ ...base, capture: { blank: ".x" } })).toThrow(/"blank"/);
  });

  // Standing rule 2: a *known* option with the wrong type is caught and named, the same as an
  // unknown key, rather than silently coerced into something that looks like a valid "off" or
  // empty value. `text()`-style silent coercion would have turned `hubUrl: 12345` into "" (the
  // feature quietly disabled) instead of a mount-time error naming the mistake.
  it("rejects a hubUrl, env or version that is given but is not a string", () => {
    expect(() => normalizeOptions({ ...base, hubUrl: 12345 })).toThrow(/"hubUrl"/);
    expect(() => normalizeOptions({ ...base, env: 12345 })).toThrow(/"env"/);
    expect(() => normalizeOptions({ ...base, version: 12345 })).toThrow(/"version"/);
  });

  it("still allows env and version to be left out", () => {
    const options = normalizeOptions(base);
    expect(options.env).toBe("");
    expect(options.version).toBe("");
  });
});

describe("defaultSection", () => {
  const sections = ["Rendering", "Mockups", "Catalog (SKU)", "General"];
  it("matches the app's current view when it is one of the sections", () => {
    expect(defaultSection(sections, "Mockups")).toBe("Mockups");
    expect(defaultSection(sections, "mockups")).toBe("Mockups");
  });
  it("falls back to the last section, which is the catch-all", () => {
    expect(defaultSection(sections, "browse")).toBe("General");
    expect(defaultSection(sections, "")).toBe("General");
  });
});
