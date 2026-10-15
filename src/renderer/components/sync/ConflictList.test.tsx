// The Issues tab rendered one card per conflict, all at once; a folder with
// ~7k conflicts froze the window and ate gigabytes. The engine now owns the
// list and this component asks for one page at a time. This pins the paging,
// the page requests it makes, and the bulk-resolve confirm step.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConflictList, CONFLICTS_PER_PAGE } from "./ConflictList";
import type { SyncConflict } from "@/lib/sync-store";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let all: SyncConflict[] = [];
const listSyncConflicts = vi.fn();
const resolveSyncConflicts = vi.fn();

beforeEach(() => {
  listSyncConflicts.mockReset();
  resolveSyncConflicts.mockReset();
  // A fake engine: serves whatever page is asked for out of `all`.
  listSyncConflicts.mockImplementation(async ({ offset, limit }: { offset: number; limit: number }) => ({
    conflicts: all.slice(offset, offset + limit),
    total: all.length,
  }));
  resolveSyncConflicts.mockResolvedValue({ queued: 0 });
  (window as unknown as { electronAPI: unknown }).electronAPI = { listSyncConflicts, resolveSyncConflicts };
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function conflicts(n: number): SyncConflict[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    pairId: "p1",
    localPath: `/sync/file-${i}.txt`,
    remoteName: `file-${i}.txt`,
    remoteId: `r${i}`,
    localMtimeMs: 0,
    remoteUpdatedAt: 0,
    localSizeBytes: 1,
    remoteSizeBytes: 1,
    detectedAt: 0,
  }));
}

/** Let the page request resolve and React commit it. */
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function render(n: number) {
  all = conflicts(n);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<ConflictList pairIds={["p1"]} total={all.length} />));
  await flush();
}

async function rerender(n: number) {
  all = conflicts(n);
  act(() => root!.render(<ConflictList pairIds={["p1"]} total={all.length} />));
  await flush();
}

const cardNames = () =>
  [...container!.querySelectorAll("p.font-semibold")].map((p) => p.textContent);
const button = (text: string) =>
  [...container!.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => {
  act(() => (el as HTMLElement).click());
  await flush();
};

describe("ConflictList", () => {
  it("asks the engine for one page and renders only that page", async () => {
    await render(7000);
    expect(listSyncConflicts).toHaveBeenLastCalledWith({ pairIds: ["p1"], offset: 0, limit: CONFLICTS_PER_PAGE });
    expect(cardNames()).toHaveLength(CONFLICTS_PER_PAGE);
    expect(cardNames()[0]).toBe("file-0.txt");
    expect(container!.textContent).toContain("1 to 50");
    expect(container!.textContent).toContain("of 7,000 conflicts");
  });

  it("pages forward, jumps to the last page, and shows the remainder", async () => {
    await render(120);
    await click(container!.querySelector('[aria-label="Next page"]'));
    expect(listSyncConflicts).toHaveBeenLastCalledWith({ pairIds: ["p1"], offset: 50, limit: CONFLICTS_PER_PAGE });
    expect(cardNames()[0]).toBe("file-50.txt");
    await click(button("3"));
    expect(cardNames()).toHaveLength(20);
    expect(cardNames()[0]).toBe("file-100.txt");
    expect(container!.querySelector('[aria-label="Next page"]')).toHaveProperty("disabled", true);
  });

  it("falls back to the last real page when resolving shrinks the list", async () => {
    await render(120);
    await click(button("3"));
    await rerender(90);
    expect(listSyncConflicts).toHaveBeenLastCalledWith({ pairIds: ["p1"], offset: 50, limit: CONFLICTS_PER_PAGE });
    expect(cardNames()).toHaveLength(40);
    expect(cardNames()[0]).toBe("file-50.txt");
  });

  it("shows no pager and no bulk bar for a single conflict", async () => {
    await render(1);
    expect(cardNames()).toHaveLength(1);
    expect(container!.querySelector('[aria-label="Next page"]')).toBeNull();
    expect(button("Keep all local")).toBeUndefined();
  });

  it("bulk resolve asks first, and only the confirm sends it", async () => {
    await render(300);
    await click(button("Keep all remote"));
    expect(resolveSyncConflicts).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("Keep all remote (300)?");
    await click(button("Cancel"));
    expect(resolveSyncConflicts).not.toHaveBeenCalled();
    await click(button("Keep all remote"));
    await click(button("Resolve all"));
    expect(resolveSyncConflicts).toHaveBeenCalledWith(["p1"], "keep-remote");
  });
});
