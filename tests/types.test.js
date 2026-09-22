import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

// types/index.d.ts is written by hand, and a hand-written declaration file drifts from the code
// the first time something is renamed — silently, because nothing in this repository compiles
// TypeScript. The shapes cannot be checked here, but the *names* can: every value the package
// exports must be declared, and nothing may be declared that the package does not export. A
// consumer importing a name that is not there gets a compile error against a file that promised
// it, which is worse than no types at all.
const VALUE_DECLARATION = /^export declare (?:function|const|class) ([A-Za-z_$][\w$]*)/gm;

describe("the hand-written type declarations", () => {
  it("declare exactly the values src/index.js exports", async () => {
    const text = await readFile(new URL("../types/index.d.ts", import.meta.url), "utf8");
    const declared = [...text.matchAll(VALUE_DECLARATION)].map((match) => match[1]).sort();
    // The regex is part of what is being trusted here, so it has to be shown to find things.
    expect(declared.length).toBeGreaterThan(3);
    expect(declared).toEqual(Object.keys(api).sort());
  });

  it("is what package.json points a consumer at", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["."].types).toBe("./types/index.d.ts");
    expect(pkg.exports["."].default).toBe("./src/index.js");
  });
});
