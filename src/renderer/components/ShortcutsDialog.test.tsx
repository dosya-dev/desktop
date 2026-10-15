// Help › Keyboard Shortcuts. The rows must agree with what the application
// menu binds (src/main/menu-template.ts); this pins the modifier spelling per
// platform and the dialog's close paths.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShortcutsDialog, shortcutSections } from "./ShortcutsDialog";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("shortcutSections", () => {
  it("spells modifiers as glyphs on macOS and as words elsewhere", () => {
    const mac = shortcutSections("darwin").flatMap((s) => s.rows);
    const win = shortcutSections("win32").flatMap((s) => s.rows);
    expect(mac.find(([l]) => l === "New folder")?.[1]).toBe("⇧⌘N");
    expect(win.find(([l]) => l === "New folder")?.[1]).toBe("Shift+Ctrl+N");
    expect(mac.find(([l]) => l === "Show or hide the sidebar")?.[1]).toBe("⌥⌘S");
    expect(win.find(([l]) => l === "Show or hide the sidebar")?.[1]).toBe("Alt+Ctrl+S");
  });

  it("lists the keys the menu binds", () => {
    const labels = shortcutSections("darwin").flatMap((s) => s.rows.map(([l]) => l));
    for (const expected of ["Search dosya", "New folder", "Upload files", "Find in document", "Settings", "Report a problem", "Keyboard shortcuts"]) {
      expect(labels).toContain(expected);
    }
  });
});

describe("ShortcutsDialog", () => {
  it("renders every section and closes on Escape", async () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { getPlatform: () => Promise.resolve("win32") };
    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<ShortcutsDialog onClose={onClose} />); });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("Keyboard shortcuts");
    expect(container.textContent).toContain("Ctrl+K");
    expect(container.querySelectorAll("section")).toHaveLength(5);

    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
