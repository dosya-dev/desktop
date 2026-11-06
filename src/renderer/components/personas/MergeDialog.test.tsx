// apps/desktop/src/renderer/components/personas/MergeDialog.test.tsx
//
// Mirrors apps/web/src/components/personas/merge-dialog.test.tsx: the list
// and the merge are this device's engine (no server Personas route).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiBase: () => "https://api.test",
}));

const { MergeDialog } = await import("./MergeDialog");
const { FakeEngine, card } = await import("@/lib/personas-device/__fixtures__/fake-host");
type PersonaCard = import("@/lib/personas").PersonaCard;
type Engine = import("@dosya-dev/personas-engine").PersonasEngine;

const EMMA: PersonaCard = card("p1", "Emma", { face_count: 30, photo_count: 412 });
const LIST: PersonaCard[] = [
  EMMA,
  card("p2", null, { face_count: 41, photo_count: 41 }),
  card("p3", "Leo", { face_count: 20, photo_count: 248 }),
];
let engine: InstanceType<typeof FakeEngine>;

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onMerged: ReturnType<typeof vi.fn<(id: string) => void>>;

beforeEach(() => {
  engine = new FakeEngine();
  engine.personas = LIST.map((p) => ({ ...p }));
  onMerged = vi.fn<(id: string) => void>();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null; container = null;
  document.body.innerHTML = "";
});

const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };

const el = (open: boolean, target: PersonaCard) => (
  <MergeDialog open={open} engine={engine as unknown as Engine} target={target} onClose={() => {}} onMerged={onMerged} />
);

async function mount(target = EMMA) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el(true, target)); });
  await flush();
}

const dialog = () => document.querySelector('[role="dialog"]')!;
const button = (label: string) => [...dialog().querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const radios = () => [...dialog().querySelectorAll<HTMLInputElement>('input[type="radio"]')];

describe("MergeDialog", () => {
  it("names the target, says it keeps its name and cover, and lists the other personas from the engine", async () => {
    await mount();
    expect(dialog().querySelector("h2")!.textContent).toBe("Merge with Emma");
    expect(dialog().textContent).toContain("Pick the persona that is also Emma. Its photos move to Emma and Emma keeps the name and cover.");
    expect(radios()).toHaveLength(2);
    expect(dialog().textContent).toContain("Unnamed");
    expect(dialog().textContent).toContain("41 photos");
    expect(dialog().textContent).toContain("Leo");
    expect(engine.listPersonas).toHaveBeenCalled();
    // Nothing picked yet: the merge button waits.
    expect(button("Merge into Emma")!.disabled).toBe(true);
  });

  it("merges the picked persona into the target", async () => {
    await mount();
    await act(async () => { radios()[0].click(); });
    await flush();
    expect(button("Merge into Emma")!.disabled).toBe(false);
    await act(async () => { button("Merge into Emma")!.click(); });
    await flush();
    expect(engine.merge).toHaveBeenCalledWith("p1", "p2");
    expect(onMerged).toHaveBeenCalledWith("p1");
  });

  it("for an unnamed target, says a named pick keeps its name", async () => {
    await mount(LIST[1]);
    expect(dialog().querySelector("h2")!.textContent).toBe("Merge with this persona");
    expect(dialog().textContent).toContain("If the one you pick has a name, it keeps the name and cover.");
    expect(button("Merge")).toBeTruthy();
  });

  it("says so when there is nobody else to merge, and when the merge fails", async () => {
    engine.personas = [{ ...EMMA }];
    await mount();
    expect(dialog().textContent).toContain("There is no other persona to merge.");
    act(() => root!.unmount()); container!.remove(); root = null;
    engine.personas = LIST.map((p) => ({ ...p }));
    engine.merge.mockRejectedValueOnce(new Error("offline"));
    await mount();
    await act(async () => { radios()[0].click(); });
    await act(async () => { button("Merge into Emma")!.click(); });
    await flush();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe("The personas could not be merged. Try again.");
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("uses no gendered pronoun", async () => {
    await mount();
    expect(dialog().textContent).not.toMatch(/\b(her|his|she|he)\b/i);
  });
});

describe("MergeDialog focus", () => {
  it("focuses the first option when it opens", async () => {
    await mount();
    expect(document.activeElement).toBe(radios()[0]);
  });

  it("focuses Cancel when there is nobody to pick", async () => {
    engine.personas = [{ ...EMMA }];
    await mount();
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("gives focus back to the opener when it closes", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(el(true, EMMA)); });
    await flush();
    expect(document.activeElement).not.toBe(opener);
    await act(async () => { root!.render(el(false, EMMA)); });
    await flush();
    expect(document.activeElement).toBe(opener);
  });
});
