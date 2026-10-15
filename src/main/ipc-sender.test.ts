// @vitest-environment node
//
// ipc-sender.ts imports originAllowed from ./trusted-origins with an
// extensionless relative specifier (the "moduleResolution": "bundler" style
// electron-vite bundles it with) - Node's own strip-only type stripping
// cannot resolve that (the same limitation documented in lan-receive.test.ts
// and the sync suites). Vitest's esbuild transform handles it, so this one
// file runs there instead of the node:test convention every other
// src/main/*.test.ts file uses - see vitest.config.ts's include list and
// package.json's test:unit glob exclusion. Its sibling
// ipc-gate-coverage.test.ts reads source as plain text and so stays on
// node:test.
import { describe, expect, it, vi } from "vitest";
import { isTrustedSender, makeIpcGate, rendererOrigin, PACKAGED_RENDERER_ORIGIN } from "./ipc-sender";

/**
 * Defense in depth (S-1). None of the app's IPC handlers used to check who
 * sent the message; they assumed the app's own top-level renderer, which is
 * true today but was never asserted. These pin the assertion down.
 */

const APP = "app://bundle";

describe("isTrustedSender", () => {
  it("trusts the app's own main frame", () => {
    expect(isTrustedSender({ url: "app://bundle/index.html", parent: null }, APP)).toBe(true);
  });

  it("does not trust a sub-frame of the app", () => {
    // The PDF viewer and the ebook reader's blob iframe live here.
    expect(isTrustedSender({ url: "app://bundle/index.html", parent: {} }, APP)).toBe(false);
  });

  it("does not trust another origin, including a prefix lookalike", () => {
    expect(isTrustedSender({ url: "https://evil.example/x", parent: null }, APP)).toBe(false);
    expect(isTrustedSender({ url: "app://bundle.evil/index.html", parent: null }, APP)).toBe(false);
  });

  it("does not trust a missing frame", () => {
    expect(isTrustedSender(null, APP)).toBe(false);
    expect(isTrustedSender(undefined, APP)).toBe(false);
  });
});

// Three configurations, and only one of them is the Vite dev server. Keying
// on `isPackaged` alone would hand the built-but-unpackaged harness - which
// loads app://bundle, and is what the whole Playwright suite runs - the
// localhost origin, and every single E2E call would be refused.
describe("rendererOrigin", () => {
  it("resolves a packaged build to app://bundle", () => {
    expect(rendererOrigin({ isPackaged: true, devServerUrl: undefined })).toBe(PACKAGED_RENDERER_ORIGIN);
    // A stale env var in a packaged build must not win over the real origin.
    expect(rendererOrigin({ isPackaged: true, devServerUrl: "http://localhost:5174" })).toBe(
      PACKAGED_RENDERER_ORIGIN,
    );
  });

  it("resolves the built-but-unpackaged harness to app://bundle", () => {
    expect(rendererOrigin({ isPackaged: false, devServerUrl: undefined })).toBe(PACKAGED_RENDERER_ORIGIN);
    expect(rendererOrigin({ isPackaged: false, devServerUrl: "" })).toBe(PACKAGED_RENDERER_ORIGIN);
  });

  it("gives only `electron-vite dev` the Vite dev server", () => {
    expect(rendererOrigin({ isPackaged: false, devServerUrl: "http://localhost:5174" })).toBe(
      "http://localhost:5174",
    );
  });
});

type Listener = (event: never, ...args: never[]) => unknown;

/** Stands in for ipcMain, which is why makeIpcGate takes the registrar. */
function fakeIpc() {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  return {
    handlers,
    listeners,
    handle(channel: string, fn: Listener) {
      handlers.set(channel, fn);
    },
    on(channel: string, fn: Listener) {
      listeners.set(channel, fn);
    },
  };
}

const trustedEvent = { senderFrame: { url: "app://bundle/index.html", parent: null } };
const subFrameEvent = { senderFrame: { url: "app://bundle/index.html", parent: {} } };

/** Call a registered listener with whatever event shape the test chooses. */
function invoke(fn: Listener, event: unknown, ...args: unknown[]): unknown {
  return (fn as unknown as (e: unknown, ...a: unknown[]) => unknown)(event, ...args);
}

describe("makeIpcGate", () => {
  it("passes a trusted sender's args and return value through handle", () => {
    const ipc = fakeIpc();
    makeIpcGate(ipc, APP).handle("x:go", (_e, a: number, b: number) => a + b);
    expect(invoke(ipc.handlers.get("x:go")!, trustedEvent, 2, 3)).toBe(5);
  });

  it("throws for an untrusted sender on handle and never runs the handler", () => {
    const ipc = fakeIpc();
    let ran = false;
    makeIpcGate(ipc, APP).handle("x:go", () => {
      ran = true;
    });
    expect(() => invoke(ipc.handlers.get("x:go")!, subFrameEvent)).toThrow(/Refused/);
    expect(ran).toBe(false);
  });

  it("returns silently for an untrusted sender on `on` - there is no reply channel", () => {
    const ipc = fakeIpc();
    let ran = 0;
    makeIpcGate(ipc, APP).on("x:tell", () => {
      ran++;
    });
    // Refused: returns undefined rather than throwing, because nothing is
    // listening for a rejection on an `on` channel.
    expect(invoke(ipc.listeners.get("x:tell")!, subFrameEvent)).toBeUndefined();
    expect(ran).toBe(0);
    invoke(ipc.listeners.get("x:tell")!, trustedEvent);
    expect(ran).toBe(1);
  });

  it("refuses a senderFrame that throws rather than propagating it", () => {
    const ipc = fakeIpc();
    const gate = makeIpcGate(ipc, APP);
    // A frame that has navigated away or been destroyed: reading the getter,
    // or reading `url` off the result, throws. Fail closed without crashing.
    const destroyed = {
      get senderFrame(): never {
        throw new Error("Render frame was disposed before WebFrameMain could be accessed");
      },
    };
    gate.handle("x:go", () => "ran");
    expect(() => invoke(ipc.handlers.get("x:go")!, destroyed)).toThrow(/Refused/);
    gate.on("x:tell", () => {
      throw new Error("must not run");
    });
    expect(invoke(ipc.listeners.get("x:tell")!, destroyed)).toBeUndefined();
  });

  it("logs a refusal once per channel, not once per call", () => {
    const ipc = fakeIpc();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      makeIpcGate(ipc, APP).on("x:tell", () => {});
      const fn = ipc.listeners.get("x:tell")!;
      invoke(fn, subFrameEvent);
      invoke(fn, subFrameEvent);
      invoke(fn, subFrameEvent);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/x:tell/);
    } finally {
      warn.mockRestore();
    }
  });
});
