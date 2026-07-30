import { test, expect } from "../fixtures";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test.describe("Sync nested folder structure", () => {
  test("initial scan recreates deep nesting on the server, not a flat list", async ({ appPage }) => {
    // Local tree: photos/2024/summer/beach/day-1 - four levels below the pair
    // root, all empty dirs so the scan exercises only folder creation.
    const base = mkdtempSync(join(tmpdir(), "dosya-e2e-nested-"));
    const localRoot = join(base, "photos");
    mkdirSync(join(localRoot, "2024", "summer", "beach", "day-1"), { recursive: true });

    try {
      const pair = await appPage.evaluate(async (path: string) => {
        const api = (window as any).electronAPI;
        return api.addSyncPair({
          workspaceId: "ws_test_1",
          workspaceName: "Test Workspace",
          localPath: path,
          remoteFolderName: "photos",
          region: "eu-west",
        });
      }, localRoot);

      const readFolders = () =>
        appPage.evaluate(async () => {
          const apiBase = await (window as any).electronAPI.getApiBase();
          const res = await fetch(`${apiBase}/__test/folders`);
          const body = await res.json();
          return body.folders as { id: string; name: string; parent_id: string | null }[];
        });

      // Wait for the initial scan to create all 5 folders (pair root + 4 nested).
      await expect
        .poll(async () => (await readFolders()).length, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(5);

      // Each folder must be parented to the previous one - a strict chain.
      // The flatten bug parks summer/beach/day-1 directly under "photos".
      const folders = await readFolders();
      const chain = ["photos", "2024", "summer", "beach", "day-1"];
      let expectedParentId: string | null = null;
      for (const name of chain) {
        const folder = folders.find((f) => f.name === name);
        expect(folder, `folder "${name}" should exist on the server`).toBeTruthy();
        expect
          .soft(folder!.parent_id, `"${name}" has the wrong parent`)
          .toBe(expectedParentId);
        expectedParentId = folder!.id;
      }

      await appPage.evaluate(
        (id: string) => (window as any).electronAPI.removeSyncPair(id),
        pair.id,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
