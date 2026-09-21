import { describe, expect, it } from "vitest";
import { byteLength } from "../src/bytes.js";

describe("byteLength", () => {
  it("counts ASCII as 1 byte per character", () => expect(byteLength("abc")).toBe(3));
  it("counts a 3-byte UTF-8 character correctly", () => expect(byteLength("中")).toBe(3));
  it("counts a surrogate-pair emoji as 4 bytes", () => expect(byteLength("😀")).toBe(4));
  it("is 0 for an empty string", () => expect(byteLength("")).toBe(0));
});
