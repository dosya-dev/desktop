import { test as base, expect } from "@playwright/test";
import http from "http";
import { gunzipSync } from "zlib";
import { launchApp } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";

/**
 * Crash reporting, end to end: an error thrown in the RENDERER has to cross
 * the preload's IPC bridge into the MAIN process, which is the only process
 * holding a DSN, and leave the machine as a Sentry envelope. An error in main
 * itself has to get out before the crash-exit path kills the app.
 *
 * Nothing short of launching the real bundles can see this: the SDK is bundled
 * (the package ships no node_modules), so its automatic preload injection is
 * dead by design and src/preload/index.ts carries the bridge instead - a
 * typecheck cannot tell whether that import survived a refactor. The "DSN" is
 * a local HTTP sink, so the test needs no network and no Sentry account.
 */

interface SentryEvent {
  exception?: { values?: { type?: string; value?: string }[] };
  release?: string;
  environment?: string;
  server_name?: string;
  user?: unknown;
  tags?: Record<string, string>;
}

function startSink(): Promise<{ url: string; events: SentryEvent[]; close: () => Promise<void> }> {
  const events: SentryEvent[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      // An envelope is newline-delimited JSON: header, then (item header, item payload) pairs.
      const lines = body.toString("utf8").split("\n");
      for (let i = 1; i + 1 < lines.length; i += 2) {
        try {
          const itemHeader = JSON.parse(lines[i]) as { type?: string };
          if (itemHeader.type === "event") events.push(JSON.parse(lines[i + 1]) as SentryEvent);
        } catch {
          // not an event item (session, client report, ...) - ignore
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        events,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function waitForEvent(events: SentryEvent[], message: string, timeoutMs = 15_000): Promise<SentryEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find((e) => e.exception?.values?.some((v) => v.value === message));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no Sentry event with message "${message}" arrived within ${timeoutMs}ms (got ${events.length})`);
}

const test = base;

test.describe("Crash reporting", () => {
  test("a renderer error reaches the DSN through main, scrubbed and tagged", async () => {
    const sink = await startSink();
    const mock = await startMockServer({ authenticated: false });
    // Unpackaged runs are off by default; DEV=1 is the documented switch.
    const { app, cleanup } = await launchApp(mock.url, {
      DOSYA_SENTRY_DSN: `${sink.url.replace("http://", "http://publickey@")}/1`,
      DOSYA_SENTRY_DEV: "1",
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      // The preload bridge is what makes the renderer's events reach main.
      expect(await page.evaluate(() => typeof (window as unknown as { __SENTRY_IPC__?: unknown }).__SENTRY_IPC__)).toBe("object");

      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("desktop-sentry-e2e-renderer");
        }, 0);
      });

      const event = await waitForEvent(sink.events, "desktop-sentry-e2e-renderer");
      // Unpackaged, app.getVersion() is Electron's own version; packaged, the
      // app's. The shape is what matters here: it is the name the release
      // workflow uploads source maps under (electron.vite.config.ts).
      expect(event.release).toMatch(/^dosya-desktop@\d+\.\d+\.\d+$/);
      expect(event.environment).toBe("development");
      // scrubEvent: no hostname, and no user while signed out.
      expect(event.server_name).toBeUndefined();
      expect(event.user).toBeUndefined();
      expect(event.tags?.["event.process"]).toBe("renderer");
    } finally {
      await app.close().catch(() => {});
      await mock.close();
      await sink.close();
      cleanup();
    }
  });

  test("a main-process uncaught exception is reported before the crash exit", async () => {
    const sink = await startSink();
    const mock = await startMockServer({ authenticated: false });
    const { app, cleanup } = await launchApp(mock.url, {
      DOSYA_SENTRY_DSN: `${sink.url.replace("http://", "http://publickey@")}/1`,
      DOSYA_SENTRY_DEV: "1",
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");

      const closed = app.waitForEvent("close", { timeout: 20_000 });
      // A genuine uncaught throw on the main event loop: the SDK's handler
      // captures it, and index.ts's crashExit flushes it out before app.exit.
      await app.evaluate(() => {
        setTimeout(() => {
          throw new Error("desktop-sentry-e2e-main");
        }, 10);
      });

      const event = await waitForEvent(sink.events, "desktop-sentry-e2e-main");
      expect(event.server_name).toBeUndefined();
      expect(event.release).toMatch(/^dosya-desktop@\d+\.\d+\.\d+$/);
      await closed; // crashExit really did exit the app
    } finally {
      await app.close().catch(() => {});
      await mock.close();
      await sink.close();
      cleanup();
    }
  });
});
