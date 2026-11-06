// apps/desktop/src/renderer/components/workspaces/ai-index-donut.test.tsx
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AccountAiWorkspace } from "@/lib/ai-search";
import { AiIndexDonut } from "./AiIndexDonut";
import { DONUT_SLOTS, MIN_ANGLE, OTHER_KEY, buildSlices, formatShare, slotsById } from "./ai-index-donut";

const ws = (id: string, images: number, documents: number, name = `WS ${id}`): AccountAiWorkspace => ({
  id, name, enabled: true, indexed: images + documents, pending: 0, images, documents, images_max: 100, documents_max: 100, paused_reason: null,
});

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let root: Root | null = null; let container: HTMLDivElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

function mount(workspaces: AccountAiWorkspace[]) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<AiIndexDonut workspaces={workspaces} />));
  return container;
}
const q = (sel: string) => container!.querySelector(sel);
const qa = (sel: string) => [...container!.querySelectorAll(sel)];

describe("buildSlices", () => {
  it("gives each workspace its true share, largest first, and skips empty ones", () => {
    const { slices, total } = buildSlices([ws("a", 10, 10), ws("b", 60, 0), ws("c", 0, 20), ws("d", 0, 0)]);
    expect(total).toBe(100);
    expect(slices.map((s) => [s.key, s.share])).toEqual([["b", 0.6], ["a", 0.2], ["c", 0.2]]);
    expect(slices[0].a0).toBe(0);
    expect(slices[slices.length - 1].a1).toBeCloseTo(2 * Math.PI);
  });

  it("folds everything past six into Other with a neutral slot", () => {
    const list = Array.from({ length: 9 }, (_, i) => ws(`w${i}`, 100 - i, 0));
    const { slices } = buildSlices(list);
    expect(slices).toHaveLength(7);
    const other = slices[6];
    expect(other.key).toBe(OTHER_KEY);
    expect(other.name).toBeNull();
    expect(other.slot).toBe(-1);
    expect(other.images).toBe(94 + 93 + 92);
    expect(new Set(slices.slice(0, 6).map((s) => s.slot)).size).toBe(DONUT_SLOTS.length);
  });

  it("colours by sorted id, so a value change never repaints", () => {
    expect([...slotsById(["z", "a", "m"]).entries()]).toEqual([["a", 0], ["m", 1], ["z", 2]]);
    const one = buildSlices([ws("a", 1, 0), ws("b", 9, 0)]).slices;
    const two = buildSlices([ws("a", 9, 0), ws("b", 1, 0)]).slices;
    expect(one.find((s) => s.key === "a")!.slot).toBe(two.find((s) => s.key === "a")!.slot);
  });

  it("draws a tiny slice at the minimum angle, taken from the largest", () => {
    const { slices } = buildSlices([ws("a", 100000, 0), ws("b", 1, 0)]);
    expect(slices[1].a1 - slices[1].a0).toBeCloseTo(MIN_ANGLE);
    expect(slices[1].share).toBeLessThan(0.0001);
    expect(formatShare(slices[1].share)).toBe("0%");
    expect(formatShare(0.005)).toBe("0.5%");
  });
});

describe("AiIndexDonut", () => {
  it("shows the empty ring and caption when nothing is indexed", () => {
    mount([ws("a", 0, 0)]);
    expect(q('[data-testid="ai-donut-empty-ring"]')).not.toBeNull();
    expect(q('[data-testid="ai-donut-empty"]')?.textContent).toBe("Nothing indexed yet");
    expect(q('svg[role="img"]')?.getAttribute("aria-label")).toBe("Nothing indexed yet");
    expect(q('[data-testid="ai-donut-legend"]')).toBeNull();
  });

  it("draws one workspace as a full circle", () => {
    mount([ws("a", 3, 2, "Team")]);
    const slices = qa('[data-testid="ai-donut-slice"]');
    expect(slices).toHaveLength(1);
    expect(slices[0].tagName.toLowerCase()).toBe("circle");
    expect(q('[data-testid="ai-donut-total"]')?.textContent).toBe("5");
    expect(container!.textContent).toContain("indexed");
  });

  it("labels the group and every slice for screen readers", () => {
    mount([ws("a", 30, 0, "Team"), ws("b", 0, 10, "Photos")]);
    const group = q('svg[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("AI index by workspace: Team 75%, Photos 25%");
    const slices = qa('[data-testid="ai-donut-slice"]');
    expect(slices.map((s) => s.tagName.toLowerCase())).toEqual(["path", "path"]);
    expect(slices.every((s) => s.getAttribute("role") === "img" && s.getAttribute("tabindex") === "0")).toBe(true);
    expect(slices[0].getAttribute("aria-label")).toBe("Team, 30 images, 0 documents, 75% of the AI index");
    expect(qa('[data-testid="ai-donut-legend-row"]').map((r) => r.textContent)).toEqual(["Team30", "Photos10"]);
  });

  it("shows the tooltip on hover and closes it with Escape", () => {
    mount([ws("a", 30, 0, "Team"), ws("b", 1, 9, "Photos")]);
    const photos = qa('[data-testid="ai-donut-slice"]').find((s) => s.getAttribute("data-key") === "b")!;
    act(() => { photos.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })); });
    const tip = q('[data-testid="ai-donut-tooltip"]')!;
    expect(tip).not.toBeNull();
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toContain("Photos");
    expect(tip.textContent).toContain("1 image");
    expect(tip.textContent).toContain("9 documents");
    expect(tip.textContent).toContain("25% of the AI index");
    // Positioned from the inline start, so it mirrors in right-to-left.
    expect((tip as HTMLElement).style.insetInlineStart).toMatch(/^0(px)?$/);
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(q('[data-testid="ai-donut-tooltip"]')).toBeNull();
  });

  it("names the folded slice Other", () => {
    mount(Array.from({ length: 8 }, (_, i) => ws(`w${i}`, 10 - i, 0)));
    const rows = qa('[data-testid="ai-donut-legend-row"]');
    expect(rows).toHaveLength(7);
    expect(rows[6].textContent).toBe("Other" + String(4 + 3));
  });
});
