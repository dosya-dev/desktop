import type { Distribution } from "./distribution";

/**
 * Which launch-at-login mechanism this build can use.
 *
 *   helper          Electron's default: a login item pointing at the app (and,
 *                   on macOS, a helper inside the bundle). Fine for the direct
 *                   download and the non-Apple stores.
 *   mainAppService  SMAppService, macOS 13+. The only mechanism that works
 *                   inside the App Sandbox, so the Mac App Store build uses it.
 *   unsupported     A sandboxed build on macOS 12: nothing works, hide the toggle.
 *
 * Pure, so the decision has a test; the Electron calls live in ipc.ts.
 */
export type LoginItemMode = "helper" | "mainAppService" | "unsupported";

export function loginItemMode({
  distribution,
  platform,
  osVersion,
}: {
  distribution: Distribution;
  platform: NodeJS.Platform;
  osVersion: string;
}): LoginItemMode {
  if (distribution !== "mas" || platform !== "darwin") return "helper";
  const major = Number.parseInt(osVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) return "unsupported";
  return major >= 13 ? "mainAppService" : "unsupported";
}
