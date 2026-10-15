// apps/desktop/src/renderer/components/family/FamilySection.test.tsx
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getFamily = vi.fn();
const inviteFamilyMember = vi.fn();
const revokeFamilyInvite = vi.fn();
const removeFamilyMember = vi.fn();
const leaveFamily = vi.fn();
vi.mock("@/lib/family-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/family-api")>()),
  getFamily: () => getFamily(),
  inviteFamilyMember: (e: string) => inviteFamilyMember(e),
  revokeFamilyInvite: (id: string) => revokeFamilyInvite(id),
  removeFamilyMember: (id: string) => removeFamilyMember(id),
  leaveFamily: () => leaveFamily(),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { FamilySection } = await import("./FamilySection");
const { showsFamilyEntry } = await import("@/lib/family-api");
const { ApiError } = await import("@/lib/api-client");

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let invalidate: { mock: { calls: unknown[][] } };
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => { for (const f of [getFamily, inviteFamilyMember, revokeFamilyInvite, removeFamilyMember, leaveFamily, toast.success, toast.error]) f.mockReset(); });
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = null; container = null; });

const pool = { used_bytes: 300, limit_bytes: 1000, used_label: "300 GB", limit_label: "1 TB" };
const payer = (over: Record<string, unknown> = {}) => ({
  ok: true, role: "payer", limit: 7, included: 5, extra_places: 2, can_buy_places: true, over_capacity: false,
  eligible: true, ineligible_reason: null, pool, plan: { id: "pro", name: "Pro" }, payer: null,
  members: [
    { id: "fm_a", email: "ada@x.test", name: "Ada", status: "active", joined_at: 1, expires_at: null, over_free: true },
    { id: "fm_b", email: "bo@x.test", name: null, status: "invited", joined_at: null, expires_at: 2_000_000_000 },
  ],
  usage: [
    { id: "u_me", name: "Me", is_you: true, is_payer: true, used_bytes: 200, used_label: "200 GB" },
    { id: "u_a", name: "Ada", is_you: false, is_payer: false, used_bytes: 100, used_label: "100 GB" },
  ],
  ...over,
});
const member = { ok: true, role: "member", limit: 5, eligible: false, ineligible_reason: "is_member", pool, plan: { id: "pro", name: "Pro" }, payer: { name: "Ayşe" }, members: null, own_used_bytes: 7, own_used_label: "7 GB" };

async function mount(showWebLink = true) {
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(qc, "invalidateQueries");
  await act(async () => { root!.render(<QueryClientProvider client={qc}><FamilySection showWebLink={showWebLink} /></QueryClientProvider>); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const text = () => document.body.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe("FamilySection", () => {
  it("payer: members, pending invite, counter with places, invite form", async () => {
    getFamily.mockResolvedValue(payer());
    await mount();
    expect(text()).toContain("Ada");
    expect(text()).toContain("bo@x.test");
    expect(text()).toContain("2 of 7 places used (5 included, 2 extra)");
    expect(document.body.querySelector('input[type="email"]')).not.toBeNull();
  });

  it("invites, clears the field and refreshes; keeps the address and shows the server message on refusal", async () => {
    getFamily.mockResolvedValue(payer());
    inviteFamilyMember.mockRejectedValueOnce(Object.assign(new Error("All 7 places are taken"), { name: "ApiError" }));
    await mount();
    const input = document.body.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "new@x.test"); input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button("Invite")!.click(); }); await flush();
    expect(toast.error).toHaveBeenCalledWith("All 7 places are taken");
    expect(input.value).toBe("new@x.test");
    inviteFamilyMember.mockResolvedValueOnce({ ok: true });
    await act(async () => { button("Invite")!.click(); }); await flush();
    expect(inviteFamilyMember).toHaveBeenLastCalledWith("new@x.test");
    expect(input.value).toBe("");
    expect(getFamily.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("remove, revoke and resend each ask first, then call the right endpoint", async () => {
    getFamily.mockResolvedValue(payer());
    removeFamilyMember.mockResolvedValue({ ok: true }); revokeFamilyInvite.mockResolvedValue({ ok: true }); inviteFamilyMember.mockResolvedValue({ ok: true });
    await mount();
    await act(async () => { button("Remove Ada")!.click(); });
    expect(text()).toContain("Remove Ada from your family plan?");
    expect(text()).toContain("uploads will pause");
    expect(removeFamilyMember).not.toHaveBeenCalled();
    await act(async () => { button("Remove")!.click(); }); await flush();
    expect(removeFamilyMember).toHaveBeenCalledWith("fm_a");
    expect(invalidate.mock.calls).toContainEqual([{ queryKey: ["dashboard-storage"] }]);
    expect(text()).not.toContain("choose a plan");

    await act(async () => { button("Revoke invitation to bo@x.test")!.click(); });
    expect(text()).toContain("Revoke the invitation to bo@x.test?");
    await act(async () => { button("Revoke")!.click(); }); await flush();
    expect(revokeFamilyInvite).toHaveBeenCalledWith("fm_b");

    await act(async () => { button("Send invitation to bo@x.test again")!.click(); });
    expect(text()).toContain("Send the invitation to bo@x.test again?");
    await act(async () => { button("Send again")!.click(); }); await flush();
    expect(inviteFamilyMember).toHaveBeenCalledWith("bo@x.test");
  });

  it("member: names the payer, shows own usage on Leave, no invite form or remove buttons", async () => {
    getFamily.mockResolvedValue(member);
    leaveFamily.mockResolvedValue({ ok: true });
    await mount();
    expect(text()).toContain("Ayşe");
    expect(document.body.querySelector('input[type="email"]')).toBeNull();
    expect(button("Remove Ada")).toBeUndefined();
    await act(async () => { button("Leave family plan")!.click(); });
    expect(text()).toContain("Leave Ayşe's family plan?");
    expect(text()).toContain("You currently store 7 GB.");
    await act(async () => { button("Leave")!.click(); }); await flush();
    expect(leaveFamily).toHaveBeenCalled();
  });

  it("over capacity: says so without any purchase wording, and disables inviting", async () => {
    getFamily.mockResolvedValue(payer({ limit: 1, included: 1, extra_places: 0, over_capacity: true }));
    await mount();
    expect(text()).toContain("You have more people than places. Nobody has been removed; new invitations wait until someone leaves.");
    expect(document.body.querySelector<HTMLInputElement>('input[type="email"]')!.disabled).toBe(true);
    expect(text()).not.toMatch(/\$|upgrade|paid plan|buy/i);
  });

  it("the web link shows only when allowed and the payer can buy places", async () => {
    getFamily.mockResolvedValue(payer());
    await mount(true);
    expect(text()).toContain("Manage places on the web");
    act(() => root!.unmount()); container!.remove(); root = null;
    await mount(false);
    expect(text()).not.toContain("Manage places on the web");
  });

  it("Usage tab lists every person with their total", async () => {
    getFamily.mockResolvedValue(payer());
    await mount();
    await act(async () => { button("Usage")!.click(); });
    expect(text()).toContain("200 GB");
    expect(text()).toContain("100 GB");
    expect(text()).toContain("Free in the pool");
  });
});

describe("FamilySection lapsed and left", () => {
  it("lapsed payer: no resend control, revoke still offered", async () => {
    getFamily.mockResolvedValue(payer({ eligible: false, ineligible_reason: "free_plan" }));
    await mount();
    expect(button("Send invitation to bo@x.test again")).toBeUndefined();
    expect(button("Revoke invitation to bo@x.test")).toBeDefined();
  });

  it("a free_plan refusal toasts the plain sentence", async () => {
    getFamily.mockResolvedValue(payer());
    inviteFamilyMember.mockRejectedValueOnce(new ApiError("Family sharing needs a paid plan", 403, { code: "free_plan" }));
    await mount();
    await act(async () => { button("Send invitation to bo@x.test again")!.click(); });
    await act(async () => { button("Send again")!.click(); }); await flush();
    expect(toast.error).toHaveBeenCalledWith("Your plan has ended, so you cannot invite anyone new.");
  });

  it("left: shows only the neutral line", async () => {
    getFamily.mockResolvedValue(payer({ role: "none", eligible: false, members: [], usage: [] }));
    await mount();
    expect(text()).toContain("You are not in a family plan.");
    expect(text()).not.toContain("places used");
    expect(text()).not.toContain("Your plan has ended");
  });
});

describe("showsFamilyEntry", () => {
  it("hides for a free user with nobody, shows for payer, member, eligible, and a lapsed payer with people", () => {
    const base = { ok: true, limit: 5, pool, plan: { id: "free", name: "Free" }, payer: null } as const;
    expect(showsFamilyEntry(undefined)).toBe(false);
    expect(showsFamilyEntry({ ...base, role: "none", eligible: false, ineligible_reason: "free_plan", members: [] } as any)).toBe(false);
    expect(showsFamilyEntry({ ...base, role: "none", eligible: true, ineligible_reason: null, members: [] } as any)).toBe(true);
    expect(showsFamilyEntry({ ...base, role: "member", eligible: false, ineligible_reason: "is_member", members: null } as any)).toBe(true);
    expect(showsFamilyEntry({ ...base, role: "none", eligible: false, ineligible_reason: "free_plan", members: [{ id: "x" }] } as any)).toBe(true);
  });
});
