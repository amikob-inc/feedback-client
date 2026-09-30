/** @vitest-environment jsdom */
// The preview dialog (owner's request, 2026-09-30): plays the recording the report will carry,
// inside the panel, loading the player only when asked. jsdom cannot run rrweb-player, so the
// player here is a stand-in with the same public surface; the real one runs in e2e/panel.spec.js.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPreview } from "../src/panel/preview.js";
import { resetWarnings } from "../src/warn.js";

function fakePlayerModule(calls) {
  class Player {
    constructor({ target, props }) {
      calls.push(["construct", props]);
      target.appendChild(document.createElement("iframe"));
      this.handlers = {};
    }
    addEventListener(name, handler) {
      this.handlers[name] = handler;
    }
    getMetaData() {
      return { startTime: 0, endTime: 103_000, totalTime: 103_000 };
    }
    toggle() {
      calls.push(["toggle"]);
    }
    pause() {
      calls.push(["pause"]);
    }
    $destroy() {
      calls.push(["destroy"]);
    }
  }
  return { Player, calls };
}

const events = [
  { type: 4, timestamp: 1000, data: { href: "http://x/" } },
  { type: 2, timestamp: 1001, data: {} },
];

afterEach(() => {
  document.body.innerHTML = "";
  resetWarnings();
});

describe("openPreview", () => {
  it("mounts the dialog at once, then loads the player and plays the events it was given", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    const module = fakePlayerModule(calls);
    const handle = openPreview({ doc: document, mount, events, load: async () => module });
    expect(mount.querySelector(".fbh-preview")).toBe(handle.element);
    expect(mount.querySelector(".fbh-preview-status").textContent).toBe("Loading the player…");
    await vi.waitFor(() => expect(calls[0]?.[0]).toBe("construct"));
    const props = calls[0][1];
    expect(props.events).toEqual(events);
    expect(props.showController).toBe(false);
    expect(props.autoPlay).toBe(true);
    expect(mount.querySelector(".fbh-preview-status").textContent).toBe("");
    expect(mount.querySelector(".fbh-preview-stage iframe")).not.toBe(null);
    handle.close();
  });

  it("Play/Pause toggles the player and follows its state; the time follows the player's clock", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    const module = fakePlayerModule(calls);
    let player;
    const OriginalPlayer = module.Player;
    module.Player = class extends OriginalPlayer {
      constructor(opts) {
        super(opts);
        player = this;
      }
    };
    const handle = openPreview({ doc: document, mount, events, load: async () => module });
    await vi.waitFor(() => expect(player).toBeDefined());
    mount.querySelector("[data-play]").click();
    expect(calls.some((c) => c[0] === "toggle")).toBe(true);
    player.handlers["ui-update-player-state"]({ payload: "paused" });
    expect(mount.querySelector("[data-play]").textContent).toBe("Play");
    player.handlers["ui-update-player-state"]({ payload: "playing" });
    expect(mount.querySelector("[data-play]").textContent).toBe("Pause");
    player.handlers["ui-update-current-time"]({ payload: 61_500 });
    expect(mount.querySelector(".fbh-preview-time").textContent).toBe("1:01 / 1:43");
    handle.close();
  });

  it("closes on the button and on Escape, destroying the player and telling the form", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    const onClose = vi.fn();
    const handle = openPreview({
      doc: document,
      mount,
      events,
      load: async () => fakePlayerModule(calls),
      onClose,
    });
    await vi.waitFor(() => expect(calls[0]?.[0]).toBe("construct"));
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mount.querySelector(".fbh-preview")).toBe(null);
    expect(calls.map((c) => c[0])).toEqual(["construct", "pause", "destroy"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    // A second close is a no-op.
    handle.close();
    expect(onClose).toHaveBeenCalledTimes(1);

    const again = openPreview({
      doc: document,
      mount,
      events,
      load: async () => fakePlayerModule([]),
    });
    mount.querySelector("[data-preview-close]").click();
    expect(mount.querySelector(".fbh-preview")).toBe(null);
    void again;
  });

  it("leaves the events it was given untouched, though the player writes on the ones it gets", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const given = [
      { type: 4, timestamp: 1000, data: { href: "http://x/" } },
      { type: 2, timestamp: 1001, data: {} },
    ];
    const before = JSON.parse(JSON.stringify(given));
    let received = null;
    // rrweb's Replayer writes `delay` onto every event object it is handed.
    class Player {
      constructor({ props }) {
        received = props.events;
        for (const event of props.events) event.delay = 0;
      }
      addEventListener() {}
      getMetaData() {
        return { totalTime: 0 };
      }
      toggle() {}
      pause() {}
      $destroy() {}
    }
    const handle = openPreview({
      doc: document,
      mount,
      events: given,
      load: async () => ({ Player }),
    });
    await vi.waitFor(() => expect(received).not.toBe(null));
    expect(given).toEqual(before);
    handle.close();
  });

  it("says so, and stays open, when the player cannot be loaded", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const handle = openPreview({
      doc: document,
      mount,
      events,
      load: async () => {
        throw new Error("offline");
      },
    });
    await vi.waitFor(() =>
      expect(mount.querySelector(".fbh-preview-status").textContent).toBe(
        "The player could not be loaded. Close this and try again.",
      ),
    );
    expect(mount.querySelector(".fbh-preview")).not.toBe(null);
    handle.close();
  });

  it("does not attach a player that arrives after the dialog was closed", async () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const calls = [];
    let release;
    const handle = openPreview({
      doc: document,
      mount,
      events,
      load: () => new Promise((resolve) => (release = () => resolve(fakePlayerModule(calls)))),
    });
    handle.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
  });
});
