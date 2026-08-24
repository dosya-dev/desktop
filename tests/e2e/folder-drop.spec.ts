import { test, expect, navigateTo, cdpFor } from "../fixtures";
import type { Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Dropping a folder used to queue an unreadable phantom - `dataTransfer.files`
 * reports a directory as ONE File with the inode's size, and reading it throws.
 * The whole point of the fix is that the tree is walked instead, so this spec
 * drops a REAL directory from disk through Chromium's own drag pipeline
 * (CDP Input.dispatchDragEvent) rather than a hand-built DataTransfer, which
 * would only re-test the fakes the unit tests already use.
 */

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-drop-"));
  const dir = path.join(root, "Photos");
  fs.mkdirSync(path.join(dir, "2024"), { recursive: true });
  fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
  fs.writeFileSync(path.join(dir, "top.txt"), "top");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "junk");
  fs.writeFileSync(path.join(dir, "2024", "nested.txt"), "nested");
  return dir;
}

async function serverState(page: Page) {
  return page.evaluate(async () => {
    const apiBase = await (window as unknown as {
      electronAPI: { getApiBase: () => Promise<string> };
    }).electronAPI.getApiBase();
    const [folders, uploads] = await Promise.all([
      fetch(`${apiBase}/__test/folders`).then((r) => r.json()),
      fetch(`${apiBase}/__test/uploads`).then((r) => r.json()),
    ]);
    return {
      folders: folders.folders as { id: string; name: string; parent_id: string | null }[],
      uploads: uploads.uploads as { file_name: string; folder_id: string | null }[],
    };
  });
}

test.describe("folder drag and drop", () => {
  test("recreates the dropped tree and uploads each file into its own folder", async ({ appPage: page }) => {
    const dir = makeTree();
    await navigateTo(page, "/files");

    const cdp = await cdpFor(page);
    const data = { items: [], files: [dir], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, x: 400, y: 400, data });
    }

    await expect.poll(async () => (await serverState(page)).uploads.length, {
      timeout: 20_000,
    }).toBe(2);

    const { folders, uploads } = await serverState(page);
    const byName = new Map(folders.map((f) => [f.name, f]));

    // The tree, including the empty directory - parents linked, not flattened.
    expect(byName.get("Photos")?.parent_id).toBe(null);
    expect(byName.get("2024")?.parent_id).toBe(byName.get("Photos")?.id);
    expect(byName.get("empty")?.parent_id).toBe(byName.get("Photos")?.id);

    // Each file initialised against ITS folder, and .DS_Store never uploaded.
    const dest = new Map(uploads.map((u) => [u.file_name, u.folder_id]));
    expect(dest.get("top.txt")).toBe(byName.get("Photos")?.id);
    expect(dest.get("nested.txt")).toBe(byName.get("2024")?.id);
    expect(dest.has(".DS_Store")).toBe(false);

    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  test("a loose file still uploads to the folder being viewed", async ({ appPage: page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-drop-"));
    const file = path.join(root, "loose.txt");
    fs.writeFileSync(file, "loose");
    await navigateTo(page, "/files");

    const cdp = await cdpFor(page);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, x: 400, y: 400, data });
    }

    await expect.poll(async () => (await serverState(page)).uploads.length, {
      timeout: 20_000,
    }).toBe(1);

    const { folders, uploads } = await serverState(page);
    expect(folders).toHaveLength(0); // no folder invented for a plain file
    expect(uploads[0]).toMatchObject({ file_name: "loose.txt", folder_id: null });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
