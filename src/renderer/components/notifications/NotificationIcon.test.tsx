import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KNOWN_ICON_KEYS, NOTIFICATION_ICON_COMPONENTS, NotificationIcon } from "./NotificationIcon";

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; container?.remove(); });

function draw(props: Parameters<typeof NotificationIcon>[0]): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<NotificationIcon {...props} />));
  return container.querySelector("[data-icon]") as HTMLElement;
}

describe("NotificationIcon (desktop)", () => {
  it("has a component for every key the shared package declares, and nothing else", () => {
    expect(Object.keys(NOTIFICATION_ICON_COMPONENTS).sort()).toEqual([...KNOWN_ICON_KEYS].sort());
  });

  it("draws the key the row carries as an svg", () => {
    const el = draw({ icon: "monitor-smartphone", category: "security", priority: "important" });
    expect(el.dataset.icon).toBe("monitor-smartphone");
    expect(el.querySelector("svg")).not.toBeNull();
  });

  it("falls back to the group, then the bell", () => {
    expect(draw({ icon: "🔐", category: "security", priority: "normal" }).dataset.icon).toBe("shield");
    expect(draw({ icon: null, category: "nope", priority: "normal" }).dataset.icon).toBe("bell");
  });

  it("takes its colour from the desktop theme variables by tone, then read state", () => {
    expect(draw({ icon: "credit-card", category: "billing", priority: "critical" }).style.color).toBe("var(--color-danger)");
    expect(draw({ icon: "user-plus", category: "team", priority: "important" }).style.color).toBe("var(--color-warning)");
    expect(draw({ icon: "upload", category: "files", priority: "normal", unread: true }).style.color).toBe("var(--color-text)");
    expect(draw({ icon: "upload", category: "files", priority: "normal" }).style.color).toBe("var(--color-text-secondary)");
  });
});
