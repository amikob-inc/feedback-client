/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createForm } from "../src/panel/form.js";
import { normalizeOptions } from "../src/options.js";

const png = (size = 4) => new Blob([new Uint8Array(size)], { type: "image/png" });

function setup({ options: extra = {}, api: apiOverrides = {}, captureScreen } = {}) {
  const options = normalizeOptions({
    hubUrl: "https://hub.example",
    app: "cad",
    getToken: async () => "t",
    section: () => "Mockups",
    sections: ["Rendering", "Mockups", "Catalog (SKU)", "General"],
    types: ["Bug", "Efficiency suggestion", "Question", "Other"],
    ...extra,
  });
  const api = {
    submit: vi.fn(async () => ({ id: "r1", dropped: [] })),
    captureScreenshot: vi.fn(async () => png()),
    options,
    ...apiOverrides,
  };
  const onSubmitted = vi.fn();
  const form = createForm({ api, options, doc: document, win: window, onSubmitted, captureScreen });
  document.body.appendChild(form.element);
  return { api, form, onSubmitted, options };
}

const $ = (selector) => document.querySelector(selector);

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("createForm", () => {
  it("offers the app's sections and types, with the current view selected", async () => {
    const { form } = setup();
    await form.prepare();
    expect([...$("#fbh-section").options].map((o) => o.value)).toEqual([
      "Rendering",
      "Mockups",
      "Catalog (SKU)",
      "General",
    ]);
    expect($("#fbh-section").value).toBe("Mockups");
    expect($("#fbh-type").value).toBe("Bug");
    form.destroy();
  });

  it("shows the automatic screenshot in the strip and lets it be removed", async () => {
    const { form, api } = setup();
    await form.prepare();
    expect(api.captureScreenshot).toHaveBeenCalledTimes(1);
    expect($(".fbh-strip").textContent).toContain("Screenshot");
    $(".fbh-strip button[data-remove]").click();
    expect($(".fbh-strip").textContent).not.toContain("Screenshot");
    expect($(".fbh-note").textContent).toBe(
      "What will be sent: a recording of the last minute or two, the console and network log.",
    );
    form.destroy();
  });

  it("retakes the screenshot on every prepare(), so a reopened panel reports on the page as it is now", async () => {
    const { form, api } = setup();
    await form.prepare();
    expect(api.captureScreenshot).toHaveBeenCalledTimes(1);
    // Simulate "opened, closed without sending, reopened": the screenshot from the first open is
    // still attached (never removed, never submitted) when prepare() runs again.
    await form.prepare();
    expect(api.captureScreenshot).toHaveBeenCalledTimes(2);
    form.destroy();
  });

  it("refuses an empty description without calling the hub", async () => {
    const { form, api } = setup();
    await form.prepare();
    $("#fbh-submit").click();
    await Promise.resolve();
    expect(api.submit).not.toHaveBeenCalled();
    expect($(".fbh-message").textContent).toBe("Add a description before sending.");
    form.destroy();
  });

  it("submits everything it holds, then clears", async () => {
    const { form, api, onSubmitted } = setup();
    await form.prepare();
    $("#fbh-text").value = "the popup does not open";
    $("#fbh-type").value = "Question";
    $("#fbh-no-replay").checked = true;
    $("#fbh-no-replay").dispatchEvent(new window.Event("change"));
    $("#fbh-submit").click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    expect(api.submit.mock.calls[0][0]).toMatchObject({
      section: "Mockups",
      type: "Question",
      text: "the popup does not open",
      includeReplay: false,
    });
    expect(onSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "r1", section: "Mockups", type: "Question" }),
    );
    expect($("#fbh-text").value).toBe("");
    form.destroy();
  });

  it("keeps everything and offers Retry when the hub refuses, without the button polluting the announced message", async () => {
    const api = {
      submit: vi.fn(async () => {
        throw Object.assign(new Error("Your session expired; sign in again."), { status: 401 });
      }),
    };
    const { form } = setup({ api });
    await form.prepare();
    $("#fbh-text").value = "still here";
    $("#fbh-submit").click();
    await vi.waitFor(() =>
      expect($(".fbh-message").textContent).toBe("Your session expired; sign in again."),
    );
    expect($("#fbh-text").value).toBe("still here");
    expect($("#fbh-retry")).not.toBe(null);
    $("#fbh-retry").click();
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
    form.destroy();
  });

  it("clears a stale Retry button when the reporter submits again with an empty description", async () => {
    const api = {
      submit: vi.fn(async () => {
        throw Object.assign(new Error("The hub had a problem. Retry."), { status: 500 });
      }),
    };
    const { form } = setup({ api });
    await form.prepare();
    $("#fbh-text").value = "will fail";
    $("#fbh-submit").click();
    await vi.waitFor(() => expect($("#fbh-retry")).not.toBe(null));
    $("#fbh-text").value = "   ";
    $("#fbh-submit").click();
    await Promise.resolve();
    expect($(".fbh-message").textContent).toBe("Add a description before sending.");
    expect($("#fbh-retry")).toBe(null);
    form.destroy();
  });

  it("says what was left out when the hub took the report but the bundle was trimmed", async () => {
    const api = {
      submit: vi.fn(async () => ({
        id: "r2",
        dropped: ["the recording (the bundle was too big)"],
      })),
    };
    const { form } = setup({ api });
    await form.prepare();
    $("#fbh-text").value = "big one";
    $("#fbh-submit").click();
    await vi.waitFor(() =>
      expect($(".fbh-message").textContent).toBe(
        "Sent. Left out: the recording (the bundle was too big).",
      ),
    );
    form.destroy();
  });

  it("takes a pasted image and refuses one that is not PNG or JPEG", async () => {
    const { form } = setup();
    await form.prepare();
    const paste = new window.Event("paste");
    paste.clipboardData = {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => png() },
        {
          kind: "file",
          type: "image/gif",
          getAsFile: () => new Blob([new Uint8Array(2)], { type: "image/gif" }),
        },
      ],
    };
    document.dispatchEvent(paste);
    await vi.waitFor(() => expect($(".fbh-strip").textContent).toContain("Image 1"));
    expect($(".fbh-strip").textContent).not.toContain("Image 2");
    expect($(".fbh-message").textContent).toBe("Only PNG and JPEG images can be attached.");
    form.destroy();
  });

  it("stops at six images", async () => {
    const { form } = setup();
    await form.prepare();
    for (let i = 0; i < 7; i += 1) form.addImage(png(), `shot-${i}.png`);
    expect($(".fbh-strip").querySelectorAll("[data-image]")).toHaveLength(6);
    expect($(".fbh-message").textContent).toBe("Six images is the most that can go with a report.");
    form.destroy();
  });

  it("refuses an image over five megabytes", async () => {
    const { form } = setup();
    await form.prepare();
    form.addImage({ size: 6 * 1024 * 1024, type: "image/png" }, "huge.png");
    expect($(".fbh-strip").querySelectorAll("[data-image]")).toHaveLength(0);
    expect($(".fbh-message").textContent).toBe("That image is over 5 MB.");
    form.destroy();
  });

  it("hides Capture screen where the browser has no getDisplayMedia, and uses it where it has", async () => {
    const { form } = setup();
    await form.prepare();
    expect($("#fbh-capture")).toBe(null);
    form.destroy();

    document.body.innerHTML = "";
    const captureScreen = vi.fn(async () => png(9));
    const withApi = setup({
      captureScreen,
      options: {},
    });
    withApi.form.element.ownerDocument.defaultView.navigator.mediaDevices = {
      getDisplayMedia() {},
    };
    await withApi.form.prepare();
    expect($("#fbh-capture")).not.toBe(null);
    $("#fbh-capture").click();
    await vi.waitFor(() => expect(captureScreen).toHaveBeenCalledTimes(1));
    expect($(".fbh-strip").textContent).toContain("Image 1");
    withApi.form.destroy();
    delete window.navigator.mediaDevices;
  });

  it("stops listening for pastes once released", async () => {
    const { form } = setup();
    await form.prepare();
    form.release();
    const paste = new window.Event("paste");
    paste.clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => png() }] };
    document.dispatchEvent(paste);
    expect($(".fbh-strip").textContent).not.toContain("Image 1");
    form.destroy();
  });

  // Standing rule 3 (task-10-brief): the app's own section() hook can throw for reasons outside
  // this module's control (mount.js guards it the same way for exactly this reason). prepare()
  // must still resolve and leave the dropdown on a sane default, not reject with an uncaught
  // error that a caller (the panel shell) has no reason to expect and might not catch.
  it("survives a throwing section() while preparing, and falls back to the last section", async () => {
    const { form } = setup({
      options: {
        section: () => {
          throw new Error("boom");
        },
      },
    });
    await expect(form.prepare()).resolves.toBeUndefined();
    expect($("#fbh-section").value).toBe("General");
    form.destroy();
  });
});
