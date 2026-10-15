import { test, expect, navigateTo, cdpFor } from "../fixtures";
import type { Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The Upload page used to send every file to the one selected folder, so a
 * dropped folder arrived flat, and its picker could only choose files. These
 * drive a REAL directory through both doors - the "Select folder" input and
 * Chromium's own drag pipeline - and check the server got the tree back, then
 * that the queue shows it as folders rather than a flat list.
 */

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-upload-"));
  const dir = path.join(root, "Photos");
  fs.mkdirSync(path.join(dir, "2024"), { recursive: true });
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

async function expectTreeOnServer(page: Page) {
  await expect.poll(async () => (await serverState(page)).uploads.length, {
    timeout: 20_000,
  }).toBe(2);
  const { folders, uploads } = await serverState(page);
  const byName = new Map(folders.map((f) => [f.name, f]));
  expect(byName.get("Photos")?.parent_id).toBe(null);
  expect(byName.get("2024")?.parent_id).toBe(byName.get("Photos")?.id);
  const dest = new Map(uploads.map((u) => [u.file_name, u.folder_id]));
  expect(dest.get("top.txt")).toBe(byName.get("Photos")?.id);
  expect(dest.get("nested.txt")).toBe(byName.get("2024")?.id);
  expect(dest.has(".DS_Store")).toBe(false);
}

test.describe("Upload page folders", () => {
  test("Select folder uploads the folder with its subfolders", async ({ appPage: page }) => {
    const dir = makeTree();
    await navigateTo(page, "/upload");
    await expect(page.getByRole("button", { name: "Select folder" })).toBeVisible();

    await page.getByTestId("upload-folder-input").setInputFiles(dir);
    await expectTreeOnServer(page);

    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  test("a folder dropped on the Upload page keeps its subfolders and shows as a tree", async ({ appPage: page }) => {
    const dir = makeTree();
    await navigateTo(page, "/upload");

    const zone = await page.getByText(/drop files or folders here/i).boundingBox();
    if (!zone) throw new Error("drop zone not on screen");
    const cdp = await cdpFor(page);
    const data = { items: [], files: [dir], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", {
        type, x: zone.x + zone.width / 2, y: zone.y + zone.height / 2, data,
      });
    }

    await expectTreeOnServer(page);

    // Folders are rows of their own, each file sits under its folder.
    const tree = page.getByRole("tree", { name: "Upload queue" });
    await expect(tree.getByRole("treeitem", { name: "Photos" })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: "2024" })).toBeVisible();
    await expect(tree.getByText("nested.txt")).toBeVisible();

    // Collapsing a folder hides what is inside it.
    await tree.getByRole("treeitem", { name: "Photos" }).click();
    await expect(tree.getByText("nested.txt")).toBeHidden();
    await expect(tree.getByRole("treeitem", { name: "2024" })).toBeHidden();

    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });
});
