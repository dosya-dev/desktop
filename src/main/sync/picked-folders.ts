/**
 * The local folders the USER chose in this app session, through the native
 * folder picker that runs in the main process (sync:pick-local-folder).
 *
 * Bounty (desktop 3.1.10): sync:add-pair took any absolute path the renderer
 * named. The renderer also runs remote script (the ONLYOFFICE api.js), so a
 * script there could register a push pair on ~/.ssh or a pull pair on
 * ~/.config without the user ever seeing a dialog. The product's own design is
 * that a human picks the folder in an OS dialog; this set is how the main
 * process holds the renderer to that. A path the renderer supplies for a new
 * or moved sync root is accepted only if it is in here.
 *
 * Pairs already saved on disk are not re-checked: they were chosen before and
 * never pass through this door again.
 *
 * Pure (platform and resolver injected) so node --test can load it.
 */
import { resolve as resolvePath } from "path";

export class PickedFolders {
  private readonly keys = new Set<string>();
  private readonly platform: NodeJS.Platform;
  private readonly resolve: (p: string) => string;

  // Plain fields, not parameter properties: node --test strips types only.
  constructor(platform: NodeJS.Platform, resolve: (p: string) => string = resolvePath) {
    this.platform = platform;
    this.resolve = resolve;
  }

  private key(path: string): string {
    let k = this.resolve(path).replace(/\\/g, "/");
    if (k.length > 1) k = k.replace(/\/+$/, "");
    // macOS and Windows file systems are case-insensitive by default; the
    // picker and the renderer may disagree on case for the same folder.
    return this.platform === "darwin" || this.platform === "win32" ? k.toLowerCase() : k;
  }

  remember(path: string): void {
    if (typeof path === "string" && path.length > 0) this.keys.add(this.key(path));
  }

  has(path: unknown): boolean {
    return typeof path === "string" && path.length > 0 && this.keys.has(this.key(path));
  }
}
