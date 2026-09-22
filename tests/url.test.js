import { describe, expect, it } from "vitest";
import { routePath, safeFragment, scrubHref } from "../src/url.js";

// The recovery landing page of the app this ships in first: supabase-js's implicit flow puts the
// session in the fragment, and cad-dashboard's auth bootstrap reads `type` and `access_token` out
// of `location.hash`. None of it may leave the browser in a report.
const SESSION = "#access_token=eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG&refresh_token=r-abc&type=recovery";

describe("safeFragment", () => {
  it("keeps a route fragment and drops one that carries parameters", () => {
    expect(safeFragment("#batch-12")).toBe("#batch-12");
    expect(safeFragment("#/orders/7")).toBe("#/orders/7");
    expect(safeFragment("")).toBe("");
    expect(safeFragment(SESSION)).toBe("");
    expect(safeFragment("#token=abc")).toBe("");
    expect(safeFragment("#/orders?page=2")).toBe("");
  });

  it("treats anything that is not a string as no fragment", () => {
    expect(safeFragment(undefined)).toBe("");
    expect(safeFragment(null)).toBe("");
    expect(safeFragment({ toString: () => "#a=b" })).toBe("");
  });
});

describe("routePath", () => {
  it("is pathname plus the fragment the rule allows, never the query", () => {
    expect(routePath({ pathname: "/rings", search: "?token=abc", hash: "#batch-12" })).toBe(
      "/rings#batch-12",
    );
    expect(routePath({ pathname: "/rings", search: "", hash: SESSION })).toBe("/rings");
    expect(routePath({ pathname: "/", hash: "" })).toBe("/");
    expect(routePath(null)).toBe("");
  });
});

describe("scrubHref", () => {
  it("strips the query and keeps a route fragment", () => {
    expect(scrubHref("https://app.example/rings?token=abc")).toBe("https://app.example/rings");
    expect(scrubHref("https://app.example/rings?token=abc#batch-7")).toBe(
      "https://app.example/rings#batch-7",
    );
    expect(scrubHref("https://app.example/rings#batch-7")).toBe(
      "https://app.example/rings#batch-7",
    );
  });

  it("drops a fragment that carries parameters, with or without a query beside it", () => {
    expect(scrubHref(`https://app.example/rings${SESSION}`)).toBe("https://app.example/rings");
    expect(scrubHref(`https://app.example/rings?x=1${SESSION}`)).toBe("https://app.example/rings");
    expect(scrubHref("https://app.example/#/orders?page=2&token=abc")).toBe("https://app.example/");
  });

  it("cuts by hand what it cannot parse, and never throws", () => {
    expect(scrubHref("not a url?token=abc")).toBe("not a url");
    expect(scrubHref("not a url?token=abc#tail")).toBe("not a url#tail");
    expect(scrubHref("not a url?token=abc#a=b")).toBe("not a url");
    expect(scrubHref("not a url#a=b")).toBe("not a url");
    expect(scrubHref("plain")).toBe("plain");
    expect(scrubHref(undefined)).toBe("");
    expect(scrubHref(null)).toBe("");
  });
});
