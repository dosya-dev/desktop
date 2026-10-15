/**
 * Who is allowed to talk to the main process over IPC.
 *
 * Defense in depth (S-1), not a live hole: there is one renderer, it only ever
 * loads app://bundle (will-navigate compares parsed origins,
 * setWindowOpenHandler denies every navigation) and the sandboxed,
 * context-isolated preload does not reach sub-frames - so the PDF iframe and
 * the ebook reader's blob iframe have no bridge, and no lower-trust principal
 * can reach these channels today. All 57 handlers *assumed* that rather than
 * asserting it, which is exactly what Electron's security checklist asks you
 * not to do: the payoff arrives only if a renderer is ever compromised, or a
 * second, less trusted window is added.
 *
 * Deliberately NOT an authorization layer. The gate answers "is this our own
 * top-level renderer?" and nothing else; every handler's own argument
 * validation and behaviour is unchanged.
 *
 * No `electron` value import here on purpose - this module is loaded by
 * `node --test`, which has no Electron, so `ipcMain` is passed in and the
 * Electron types are type-only (erased at runtime).
 */

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";

// Extensionless, the project's convention - electron-vite resolves it. Node's
// own test runner cannot, which is why ipc-sender.test.ts runs on vitest (see
// its header and vitest.config.ts), exactly like the sync and lan-receive
// suites.
import { originAllowed } from "./trusted-origins";

/** The origin the renderer runs at in every build that is not `electron-vite dev`. */
export const PACKAGED_RENDERER_ORIGIN = "app://bundle";

/**
 * The origin the renderer actually runs at, mirroring createWindow's loadURL
 * branch in index.ts exactly.
 *
 * Three configurations, one of which gets localhost:
 *   - packaged                        -> app://bundle
 *   - built but unpackaged (the test harness, `electron-vite preview`)
 *                                     -> app://bundle
 *   - `electron-vite dev`             -> ELECTRON_RENDERER_URL
 *
 * Keying on `app.isPackaged` alone is the tempting mistake: it hands the
 * built-but-unpackaged harness - which is what the whole Playwright suite
 * runs - the localhost origin, and then every E2E call is refused.
 */
export function rendererOrigin(opts: { isPackaged: boolean; devServerUrl: string | undefined }): string {
  return !opts.isPackaged && opts.devServerUrl ? opts.devServerUrl : PACKAGED_RENDERER_ORIGIN;
}

/** Just enough of Electron's WebFrameMain to decide, and all `node --test` can build. */
type SenderFrame = { url: string; parent: unknown };

/**
 * Whether an IPC message came from the app's own top-level renderer.
 *
 * `parent === null` is what rejects a sub-frame. `originAllowed` is the same
 * parsed-origin comparison will-navigate uses - deliberately not a
 * `startsWith`, which once accepted `http://localhost:5174.evil.example`.
 */
export function isTrustedSender(frame: SenderFrame | null | undefined, allowedOrigin: string): boolean {
  if (!frame) return false;
  if (frame.parent !== null) return false;
  return originAllowed(frame.url, [allowedOrigin]);
}

// A gate is channel-agnostic, so the payload is `any` rather than `unknown`:
// `unknown` would force every one of the 57 call sites to re-narrow arguments
// their own handler already types and validates. The gate never reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = any[];

export interface IpcGate {
  /** `ipcMain.handle`, but only for our own top-level renderer. */
  handle(channel: string, fn: (event: IpcMainInvokeEvent, ...args: AnyArgs) => unknown): void;
  /** `ipcMain.on`, same gate. */
  on(channel: string, fn: (event: IpcMainEvent, ...args: AnyArgs) => void): void;
}

/** The part of `ipcMain` the gate needs, so a unit test can supply a fake. */
type IpcRegistrar = Pick<IpcMain, "handle" | "on">;

/**
 * Wrap `ipcMain.handle` / `ipcMain.on` so every channel refuses a sender that
 * is not the app's own top-level renderer.
 *
 * `ipcMain` is passed in rather than imported so this module stays loadable by
 * `node --test` (see the header). Pass `ipcMain` at every call site.
 *
 * A refusal surfaces differently per registration kind, on purpose:
 *   - `handle` throws, which rejects the renderer's promise.
 *   - `on` just returns: there is no reply channel to reject on.
 *
 * Fails closed without crashing. `senderFrame` is null for a frame that has
 * already navigated away, and on a destroyed frame both the getter and
 * reading `url` off it can throw ("Render frame was disposed before
 * WebFrameMain could be accessed") - either way the message is refused. The
 * warning is emitted at most once per channel so a chatty channel cannot turn
 * a refusal into a log flood.
 */
export function makeIpcGate(ipc: IpcRegistrar, allowedOrigin: string): IpcGate {
  const warned = new Set<string>();

  const allow = (channel: string, event: { senderFrame?: SenderFrame | null }): boolean => {
    let ok = false;
    try {
      ok = isTrustedSender(event.senderFrame, allowedOrigin);
    } catch {
      ok = false;
    }
    if (!ok && !warned.has(channel)) {
      warned.add(channel);
      console.warn(`[ipc] refused ${channel} from an untrusted frame (further refusals on this channel are silent)`);
    }
    return ok;
  };

  return {
    handle(channel, fn) {
      ipc.handle(channel, (event, ...args) => {
        if (!allow(channel, event)) throw new Error("Refused");
        return fn(event, ...args);
      });
    },
    on(channel, fn) {
      ipc.on(channel, (event, ...args) => {
        if (!allow(channel, event)) return;
        fn(event, ...args);
      });
    },
  };
}
