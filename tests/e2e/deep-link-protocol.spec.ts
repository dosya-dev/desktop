import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

import { DEEP_LINK_SCHEME, findDeepLinkArg, protocolClientRegistration } from "../../src/main/deep-link";

/**
 * Guards for the dosya:// deep link on Windows.
 *
 * Live bug this file exists for: Windows users clicked "Continue with Google",
 * the system browser finished OAuth, the API 302'd to
 * `dosya://auth/callback?token=...` - and nothing happened. The tab just sat
 * there.
 *
 * The scheme was never registered with Windows. `protocols:` in
 * electron-builder.yml is only consumed by the macOS (Info.plist), Linux
 * (.desktop) and AppX packagers; the NSIS target ignores it entirely, and
 * nothing called `app.setAsDefaultProtocolClient`. macOS worked off the same
 * config line, so the whole flow looked healthy from a Mac.
 *
 * Nothing here launches Electron: the packaging config and the OS-registration
 * call are exactly the parts an app-level e2e test runs straight past.
 */

const desktopRoot = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(desktopRoot, rel), "utf8");

test.describe("deep link argv parsing", () => {
  test("finds the URL Windows appends to argv", () => {
    // What Windows actually hands the second instance: exe path, then the URL.
    const argv = ["C:\\Users\\x\\AppData\\Local\\Programs\\dosya\\dosya.exe", "dosya://auth/callback?token=abc&state=n1"];
    expect(findDeepLinkArg(argv)).toBe("dosya://auth/callback?token=abc&state=n1");
  });

  test("survives the quoting and casing the shell can add", () => {
    expect(findDeepLinkArg(["dosya.exe", '"dosya://sync?path=C:\\Docs"'])).toBe("dosya://sync?path=C:\\Docs");
    expect(findDeepLinkArg(["dosya.exe", "DOSYA://auth/callback?token=abc"])).toBe("DOSYA://auth/callback?token=abc");
  });

  test("returns null when no deep link is present", () => {
    expect(findDeepLinkArg(["dosya.exe", "--inspect", "https://dosya.dev"])).toBeNull();
    expect(findDeepLinkArg([])).toBeNull();
  });

  test("never mistakes a lookalike argument for the scheme", () => {
    expect(findDeepLinkArg(["dosya.exe", "https://evil.test/dosya://auth"])).toBeNull();
    expect(findDeepLinkArg(["dosya.exe", "dosyavault://auth"])).toBeNull();
  });
});

test.describe("OS protocol-client registration", () => {
  test("packaged builds register the scheme with no argv trailer", () => {
    const reg = protocolClientRegistration({
      isPackaged: true,
      execPath: "C:\\Program Files\\dosya\\dosya.exe",
      argv: ["C:\\Program Files\\dosya\\dosya.exe"],
    });
    expect(reg.scheme).toBe(DEEP_LINK_SCHEME);
    expect(reg.execPath).toBeUndefined();
    expect(reg.args).toBeUndefined();
  });

  test("dev builds point Windows at electron.exe plus the app entry", () => {
    // Unpackaged, `setAsDefaultProtocolClient("dosya")` would register bare
    // electron.exe, so the OS launches Electron with no app to run.
    const reg = protocolClientRegistration({
      isPackaged: false,
      execPath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe",
      argv: ["C:\\repo\\node_modules\\electron\\dist\\electron.exe", "out\\main\\index.js"],
      resolvePath: (p) => `C:\\repo\\${p}`,
    });
    expect(reg.execPath).toBe("C:\\repo\\node_modules\\electron\\dist\\electron.exe");
    expect(reg.args).toEqual(["C:\\repo\\out\\main\\index.js"]);
  });

  test("dev build with no entry argument does not register a bare runtime", () => {
    const reg = protocolClientRegistration({
      isPackaged: false,
      execPath: "/usr/bin/electron",
      argv: ["/usr/bin/electron"],
    });
    expect(reg.execPath).toBeUndefined();
  });
});

test.describe("main process wiring", () => {
  const mainSource = read("src/main/index.ts");

  test("asks the OS to register the scheme at startup", () => {
    // The bug: this call did not exist anywhere in the repo.
    expect(mainSource).toContain("setAsDefaultProtocolClient");
  });

  test("reads a cold-start deep link off process.argv", () => {
    // `open-url` is macOS-only and `second-instance` only fires when an
    // instance already holds the lock, so without this a link that starts the
    // app on Windows is dropped.
    expect(mainSource).toMatch(/findDeepLinkArg\(\s*process\.argv\s*\)/);
  });

  test("second-instance argv goes through the shared parser", () => {
    expect(mainSource).toMatch(/second-instance[\s\S]{0,400}findDeepLinkArg\(argv\)/);
  });
});

test.describe("NSIS installer registration", () => {
  const nsh = read("build/installer.nsh");

  test("electron-builder is pointed at the custom include", () => {
    // Without this the file is inert and the scheme is unregistered until the
    // app happens to run once.
    expect(read("electron-builder.yml")).toMatch(/include:\s*build\/installer\.nsh/);
  });

  test("writes the URL-protocol keys the browser looks up", () => {
    expect(nsh).toMatch(/!macro customInstall/);
    expect(nsh).toMatch(/WriteRegStr SHELL_CONTEXT "Software\\Classes\\dosya" "URL Protocol" ""/);
    // The "%1" placeholder is what carries the callback URL into argv.
    expect(nsh).toMatch(/Software\\Classes\\dosya\\shell\\open\\command[\s\S]*%1/);
  });

  test("uninstall removes the keys it added", () => {
    expect(nsh).toMatch(/!macro customUnInstall[\s\S]*DeleteRegKey SHELL_CONTEXT "Software\\Classes\\dosya"/);
  });
});
