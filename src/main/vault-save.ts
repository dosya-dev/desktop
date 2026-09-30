import { basename, join } from "path";

/**
 * Where a file decrypted by the Vault is written.
 *
 * The renderer holds the plaintext (it did the decrypting) but never a path.
 * It asks by NAME, this process puts a save dialog in front of the user, and
 * the path the user picked is the only place bytes go. The name is untrusted -
 * it came from a Space another member may have written - so it is reduced to a
 * leaf before it can even become the dialog's suggestion. Same discipline as
 * lan-receive.ts.
 *
 * Pure: `deps` carries the Electron pieces so this can be unit tested on Node.
 */
export const MAX_VAULT_SAVE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB, already past the renderer's heap

export type VaultSaveResult = { ok: true; path: string } | { ok: false; canceled: true };

export type VaultSaveDeps = {
  showSaveDialog(opts: { title: string; defaultPath: string }): Promise<{ canceled: boolean; filePath?: string }>;
  downloadsDir(): string;
  write(path: string, bytes: Uint8Array): Promise<void>;
};

/** A leaf file name safe to suggest in a dialog. Never empty, never dot-only, never a path. */
export function safeVaultFileName(name: unknown): string {
  if (typeof name !== "string") return "vault-file";
  // basename() understands the host separator only; neutralise the Windows
  // separator and drive colon first so "C:\x" cannot survive as a path anywhere.
  const leaf = basename(name.replace(/[\\:]/g, "_")).replace(/[/\\]/g, "_").replace(/^\.+/, "");
  const trimmed = leaf.slice(0, 255);
  return trimmed && trimmed !== "." && trimmed !== ".." ? trimmed : "vault-file";
}

export async function saveVaultBytes(name: unknown, bytes: unknown, deps: VaultSaveDeps): Promise<VaultSaveResult> {
  const buf =
    bytes instanceof Uint8Array ? bytes
    : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
    : null;
  if (!buf || buf.byteLength > MAX_VAULT_SAVE_BYTES) throw new Error("Invalid bytes");

  const safeName = safeVaultFileName(name);
  const { canceled, filePath } = await deps.showSaveDialog({
    title: "Save decrypted file",
    defaultPath: join(deps.downloadsDir(), safeName),
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  await deps.write(filePath, buf);
  return { ok: true, path: filePath };
}
