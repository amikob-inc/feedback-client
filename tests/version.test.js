import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIENT_ID, CLIENT_VERSION } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("version", () => {
  it("is the version in package.json", () => {
    expect(CLIENT_VERSION).toBe(pkg.version);
  });

  it("is the client string the report carries", () => {
    expect(CLIENT_ID).toBe("feedback-client/0.1.1");
    expect(CLIENT_ID).toBe(`feedback-client/${pkg.version}`);
  });
});
