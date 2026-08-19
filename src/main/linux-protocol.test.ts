import { test } from "node:test";
import assert from "node:assert/strict";

import { linuxProtocolInstallPlan } from "./linux-protocol.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * The bug these pin down: a downloaded AppImage installs nothing, so the
 * `MimeType=x-scheme-handler/dosya;` entry electron-builder writes into the
 * desktop file INSIDE the AppImage never reaches the system. The browser then
 * has no handler for the OAuth redirect and Xfce shows "Failed to open URI.
 * The specified location is not supported." The plan computed here is what the
 * running app installs at startup to give the OS a handler.
 */

const APPIMAGE = "/home/user/Downloads/dosya-3.0.0-x86_64.AppImage";

function plan(overrides: Partial<Parameters<typeof linuxProtocolInstallPlan>[0]> = {}) {
  return linuxProtocolInstallPlan({
    platform: "linux",
    isPackaged: true,
    env: { APPIMAGE },
    home: "/home/user",
    argv: ["/tmp/.mount_dosya/dosya"],
    ...overrides,
  });
}

// ── when the plan applies ──────────────────────────────────────────

test("no plan outside packaged Linux AppImage runs", () => {
  assert.equal(plan({ platform: "darwin" }), null);
  assert.equal(plan({ platform: "win32" }), null);
  // dev run on Linux: no AppImage runtime, nothing to point Exec at
  assert.equal(plan({ isPackaged: false }), null);
  // deb install: the package manager installed the real desktop entry; do not
  // shadow it with a user-local one
  assert.equal(plan({ env: {} }), null);
  // a relative/garbage APPIMAGE value must not end up in an Exec line
  assert.equal(plan({ env: { APPIMAGE: "Downloads/dosya.AppImage" } }), null);
});

// ── file locations ─────────────────────────────────────────────────

test("desktop entry lands in XDG data home applications dir", () => {
  const p = plan();
  assert.ok(p);
  assert.equal(p.desktopDir, "/home/user/.local/share/applications");
  assert.equal(p.desktopPath, "/home/user/.local/share/applications/dosya.desktop");
  assert.equal(p.mimeappsPath, "/home/user/.config/mimeapps.list");
});

test("XDG_DATA_HOME and XDG_CONFIG_HOME override the defaults", () => {
  const p = plan({ env: { APPIMAGE, XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/conf" } });
  assert.ok(p);
  assert.equal(p.desktopDir, "/data/applications");
  assert.equal(p.mimeappsPath, "/conf/mimeapps.list");
});

// ── desktop entry content ──────────────────────────────────────────

test("desktop entry declares the scheme handler and launches the AppImage", () => {
  const p = plan();
  assert.ok(p);
  const lines = p.desktopContent.split("\n");
  assert.equal(lines[0], "[Desktop Entry]");
  assert.ok(lines.includes("Type=Application"));
  assert.ok(lines.includes("MimeType=x-scheme-handler/dosya;"));
  assert.ok(lines.includes(`Exec="${APPIMAGE}" %U`));
  assert.ok(lines.includes("Terminal=false"));
  // scheme plumbing, not menu integration - keep it out of app launchers
  assert.ok(lines.includes("NoDisplay=true"));
  assert.ok(p.desktopContent.endsWith("\n"));
});

test("a path with spaces stays one quoted Exec argument", () => {
  const p = plan({ env: { APPIMAGE: "/home/user/My Apps/dosya.AppImage" } });
  assert.ok(p);
  assert.ok(p.desktopContent.includes('Exec="/home/user/My Apps/dosya.AppImage" %U'));
});

test("Exec escapes the desktop-entry reserved characters", () => {
  const p = plan({ env: { APPIMAGE: '/home/us$er/do"wn`lo\\ads/dosya.AppImage' } });
  assert.ok(p);
  // Two escaping passes read this back (string escape, then quote parsing):
  // \ -> \\\\   " -> \\"   $ -> \\$   ` -> \\`
  assert.ok(
    p.desktopContent.includes('Exec="/home/us\\\\$er/do\\\\"wn\\\\`lo\\\\\\\\ads/dosya.AppImage" %U'),
  );
});

test("literal percent signs survive field-code expansion", () => {
  const p = plan({ env: { APPIMAGE: "/home/user/100%/dosya.AppImage" } });
  assert.ok(p);
  assert.ok(p.desktopContent.includes('Exec="/home/user/100%%/dosya.AppImage" %U'));
});

test("--no-sandbox is carried over when the running app needed it", () => {
  // Root VM case: without the flag Chromium refuses to start, so the
  // browser-launched second instance would die before forwarding the URL.
  const p = plan({ argv: ["/tmp/.mount_dosya/dosya", "--no-sandbox", "--enable-unsafe-swiftshader"] });
  assert.ok(p);
  assert.ok(p.desktopContent.includes(`Exec="${APPIMAGE}" --no-sandbox %U`));
  // rendering flags are not fatal to a URL forwarder - leave them out
  assert.ok(!p.desktopContent.includes("swiftshader"));
});

// ── mimeapps.list merge ────────────────────────────────────────────

test("merge creates mimeapps.list from scratch", () => {
  const p = plan();
  assert.ok(p);
  assert.equal(
    p.mergeMimeapps(null),
    "[Default Applications]\nx-scheme-handler/dosya=dosya.desktop\n",
  );
});

test("merge appends the section to an unrelated existing file", () => {
  const p = plan();
  assert.ok(p);
  const existing = "[Added Associations]\ntext/plain=gedit.desktop\n";
  assert.equal(
    p.mergeMimeapps(existing),
    "[Added Associations]\ntext/plain=gedit.desktop\n\n[Default Applications]\nx-scheme-handler/dosya=dosya.desktop\n",
  );
});

test("merge inserts into an existing Default Applications section", () => {
  const p = plan();
  assert.ok(p);
  const existing =
    "[Default Applications]\ntext/html=firefox.desktop\n\n[Added Associations]\ntext/plain=gedit.desktop\n";
  assert.equal(
    p.mergeMimeapps(existing),
    "[Default Applications]\nx-scheme-handler/dosya=dosya.desktop\ntext/html=firefox.desktop\n\n[Added Associations]\ntext/plain=gedit.desktop\n",
  );
});

test("merge replaces a stale handler instead of duplicating the key", () => {
  const p = plan();
  assert.ok(p);
  const existing = "[Default Applications]\nx-scheme-handler/dosya=stale.desktop\n";
  assert.equal(
    p.mergeMimeapps(existing),
    "[Default Applications]\nx-scheme-handler/dosya=dosya.desktop\n",
  );
});

test("merge is idempotent", () => {
  const p = plan();
  assert.ok(p);
  const once = p.mergeMimeapps(null);
  assert.equal(p.mergeMimeapps(once), once);
});

// ── post-install commands ──────────────────────────────────────────

test("plan refreshes the desktop database so handler discovery works", () => {
  const p = plan();
  assert.ok(p);
  assert.deepEqual(p.postCommands, [
    { cmd: "update-desktop-database", args: ["/home/user/.local/share/applications"] },
  ]);
});
