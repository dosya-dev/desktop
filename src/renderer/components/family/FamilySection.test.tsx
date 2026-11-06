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
const setFamilyReservation = vi.fn();
vi.mock("@/lib/family-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/family-api")>()),
  getFamily: () => getFamily(),
  inviteFamilyMember: (e: string) => inviteFamilyMember(e),
  revokeFamilyInvite: (id: string) => revokeFamilyInvite(id),
  removeFamilyMember: (id: string) => removeFamilyMember(id),
  leaveFamily: () => leaveFamily(),
  setFamilyReservation: (id: string, gb: number | null) => setFamilyReservation(id, gb),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast }));

const { FamilySection } = await import("./FamilySection");
const { showsFamilyEntry } = await import("@/lib/family-api");
const { ApiError } = await import("@/lib/api-client");
const { personColor } = await import("./family-colors");

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
let invalidate: { mock: { calls: unknown[][] } };
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeEach(() => { for (const f of [getFamily, inviteFamilyMember, revokeFamilyInvite, removeFamilyMember, leaveFamily, setFamilyReservation, toast.success, toast.error]) f.mockReset(); });
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

// ---- storage reservations + the redesigned section ----
const GBn = 1024 ** 3;
// The example family on a 1 TB plan (1000 GB pool): Emma has 200 GB reserved, Sam 150 GB.
const reservedFamily = (over: Record<string, unknown> = {}) => ({
  ok: true, role: "payer", limit: 5, included: 5, extra_places: 0, can_buy_places: false, over_capacity: false, eligible: true, ineligible_reason: null,
  pool: { used_bytes: 703 * GBn, limit_bytes: 1000 * GBn, used_label: "703 GB", limit_label: "1 TB", reserved_bytes: 350 * GBn, held_bytes: 70 * GBn, free_bytes: 227 * GBn },
  reservations_exceed_pool: false,
  plan: { id: "pro", name: "Pro" }, payer: null,
  members: [
    { id: "fm_e", email: "emma@example.com", name: "Emma", status: "active", joined_at: 1, expires_at: null, reserved_bytes: 200 * GBn, used_bytes: 184 * GBn, max_reservable_bytes: 427 * GBn, user_id: "u_emma" },
    { id: "fm_s", email: "sam@example.com", name: "Sam", status: "active", joined_at: 1, expires_at: null, reserved_bytes: 150 * GBn, used_bytes: 96 * GBn, max_reservable_bytes: 377 * GBn, user_id: "u_sam" },
    { id: "fm_m", email: "mia@example.com", name: "Mia", status: "active", joined_at: 1, expires_at: null, reserved_bytes: null, used_bytes: 72 * GBn, max_reservable_bytes: 299 * GBn, user_id: "u_mia" },
    { id: "fm_l", email: "leo@example.com", name: "Leo", status: "active", joined_at: 1, expires_at: null, reserved_bytes: null, used_bytes: 41 * GBn, max_reservable_bytes: 268 * GBn, user_id: "u_leo" },
    { id: "fm_a", email: "ava@example.com", name: null, status: "invited", joined_at: null, expires_at: 2_000_000_000, reserved_bytes: null, user_id: null },
  ],
  usage: [
    { id: "u_alex", name: "Alex", is_you: true, is_payer: true, used_bytes: 310 * GBn, used_label: "310 GB", reserved_bytes: null },
    { id: "u_emma", name: "Emma", is_you: false, is_payer: false, used_bytes: 184 * GBn, used_label: "184 GB", reserved_bytes: 200 * GBn },
    { id: "u_sam", name: "Sam", is_you: false, is_payer: false, used_bytes: 96 * GBn, used_label: "96 GB", reserved_bytes: 150 * GBn },
    { id: "u_mia", name: "Mia", is_you: false, is_payer: false, used_bytes: 72 * GBn, used_label: "72 GB", reserved_bytes: null },
    { id: "u_leo", name: "Leo", is_you: false, is_payer: false, used_bytes: 41 * GBn, used_label: "41 GB", reserved_bytes: null },
  ],
  ...over,
});
const memberView = (over: Record<string, unknown> = {}) => {
  const f = reservedFamily();
  return { ...f, role: "member", eligible: false, ineligible_reason: "is_member", payer: { name: "Alex" }, members: null,
    usage: f.usage.map((u) => ({ ...u, is_you: u.name === "Emma" })),
    own_used_bytes: 184 * GBn, own_used_label: "184 GB", own_reserved_bytes: 200 * GBn, ...over };
};
const rowOf = (name: string) => [...document.body.querySelectorAll("li")].find((li) => li.querySelector('[data-slot="person-name"]')?.textContent === name) as HTMLElement;
const dialogEl = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const rowButton = (name: string, label: string) => [...rowOf(name).querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const click = async (el: Element | undefined) => { expect(el).toBeDefined(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };

describe("FamilySection reservations", () => {
  it("header chips name the plan and the places; the pool line counts the reservations", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    await mount();
    const chips = [...document.body.querySelectorAll('[data-slot="family-chip"]')].map((n) => n.textContent);
    expect(chips).toEqual(["Pro · 1 TB", "5 places included"]);
    expect(text()).toContain("703 GB of 1 TB used · 350 GB reserved for 2 people.");
  });

  it("member view: the chips say Shared with you", async () => {
    getFamily.mockResolvedValue(memberView());
    await mount();
    const chips = [...document.body.querySelectorAll('[data-slot="family-chip"]')].map((n) => n.textContent);
    expect(chips).toEqual(["Pro · 1 TB", "Shared with you"]);
  });

  it("rows: the payer pays the plan, an invitation has a dashed avatar, reservations show on the row", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    await mount();
    expect(rowOf("Alex (you)").textContent).toContain("Pays the plan");
    const ava = rowOf("ava@example.com");
    expect(ava.textContent).toContain("Invited");
    expect(ava.querySelector('[data-slot="avatar"]')?.className).toContain("border-dashed");
    expect(rowOf("Emma").textContent).toContain("184 of 200 GB reserved");
    expect(rowButton("Emma", "200 GB")).toBeDefined();
    expect(rowOf("Mia").textContent).toContain("72 GB · shares the pool");
    expect(rowButton("Mia", "Reserve")).toBeDefined();
    // The row actions keep their names.
    expect(button("Remove Emma")).toBeDefined();
    expect(button("Revoke invitation to ava@example.com")).toBeDefined();
  });

  it("+ Reserve opens the dialog for that person with the max the server allows", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    await mount();
    await click(rowButton("Mia", "Reserve"));
    const d = dialogEl()!;
    expect(d.textContent).toContain("Reserve storage for Mia");
    for (const pick of ["50", "100", "200", "Max 299"]) expect([...d.querySelectorAll("button")].some((b) => b.textContent === pick), pick).toBe(true);
  });

  it("saving a reservation closes the dialog and refreshes the family and the storage figures", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    setFamilyReservation.mockResolvedValue({ ok: true });
    await mount();
    await click(rowButton("Mia", "Reserve"));
    await click([...dialogEl()!.querySelectorAll("button")].find((b) => b.textContent === "Reserve 100 GB"));
    expect(setFamilyReservation).toHaveBeenCalledWith("fm_m", 100);
    expect(dialogEl()).toBeNull();
    expect(invalidate.mock.calls).toContainEqual([{ queryKey: ["family"] }]);
    expect(invalidate.mock.calls).toContainEqual([{ queryKey: ["dashboard-storage"] }]);
    expect(getFamily.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("the reservation button opens the change dialog, and Remove asks Are you sure?", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    await mount();
    await click(rowButton("Emma", "200 GB"));
    expect(dialogEl()!.textContent).toContain("Change Emma’s reservation");
    await click([...dialogEl()!.querySelectorAll("button")].find((b) => b.textContent === "Remove reservation"));
    expect(dialogEl()!.textContent).toContain("Are you sure?");
    expect(dialogEl()!.textContent).toContain("You are ending Emma’s 200 GB reservation. Their files stay. They share the free space in the pool again.");
  });

  it("a lapsed payer gets no reservation controls", async () => {
    getFamily.mockResolvedValue(reservedFamily({ eligible: false, ineligible_reason: "free_plan", plan: { id: "free", name: "Free" } }));
    await mount();
    expect([...document.body.querySelectorAll("button")].some((b) => b.textContent === "Reserve" || b.textContent === "200 GB")).toBe(false);
    expect(rowOf("Emma").textContent).toContain("Joined");
  });

  it("an older API without reservation fields shows the email and Joined, no reservation controls", async () => {
    getFamily.mockResolvedValue(payer());
    await mount();
    expect(rowOf("Ada").textContent).toContain("ada@x.test");
    expect(rowOf("Ada").textContent).toContain("Joined");
    expect(rowButton("Ada", "Reserve")).toBeUndefined();
  });

  it("member view: the reserved member sees their own reservation", async () => {
    getFamily.mockResolvedValue(memberView());
    await mount();
    expect(text()).toContain("Reserved for you by Alex");
    expect(text()).toContain("184 of 200 GB");
    expect(text()).toContain("This space is yours alone. Uploads stop at 200 GB.");
    expect(rowOf("Emma (you)")).toBeDefined();
    expect(rowOf("Alex").textContent).toContain("Pays the plan");
    expect(rowOf("Sam").textContent).toContain("Joined");
    expect(button("Leave family plan")).toBeDefined();
    expect([...document.body.querySelectorAll("button")].some((b) => b.textContent === "Reserve")).toBe(false);
  });

  it("member without a reservation sees no reservation box", async () => {
    getFamily.mockResolvedValue(memberView({ own_reserved_bytes: null, usage: reservedFamily().usage.map((u) => ({ ...u, is_you: u.name === "Mia" })) }));
    await mount();
    expect(text()).not.toContain("Reserved for you by");
  });

  it("reservations over the pool: the payer is told to lower them", async () => {
    getFamily.mockResolvedValue(reservedFamily({ reservations_exceed_pool: true }));
    await mount();
    expect(text()).toContain("Reservations add up to more than your plan. Lower them so everyone can upload.");
  });

  it("the warning re-colours when the theme changes, without a reload", async () => {
    const { applyTheme } = await import("@/lib/theme");
    const { DEFAULT_THEME } = await import("@/lib/themes");
    document.documentElement.classList.remove("dark");
    try {
      getFamily.mockResolvedValue(reservedFamily({ reservations_exceed_pool: true }));
      await mount();
      const warn = () => [...document.body.querySelectorAll('[role="status"]')]
        .find((n) => n.textContent?.includes("Reservations add up")) as HTMLElement;
      expect(warn().style.color).toBe("rgb(180, 83, 9)");
      await act(async () => { applyTheme({ theme: DEFAULT_THEME, mode: "dark" }); });
      expect(warn().style.color).toBe("rgb(251, 191, 36)");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("Members and Usage always sit behind the pill toggle", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    await mount();
    expect([...document.body.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Members", "Usage"]);
    expect(document.body.querySelector('[data-slot="family-legend"]')).toBeNull();
    expect(document.body.querySelector('[data-slot="family-columns"]')).toBeNull();
  });

  it("usage legend splits what is free to share from what is held for reservations", async () => {
    getFamily.mockResolvedValue(reservedFamily());
    await mount();
    await click(button("Usage"));
    const legend = document.body.querySelector('[data-slot="family-legend"]') as HTMLElement;
    const free = [...legend.querySelectorAll("li")].find((l) => l.textContent?.includes("Free to share"))!;
    expect(free.textContent).toContain("227 GB");
    const held = [...legend.querySelectorAll("li")].find((l) => l.textContent?.includes("Held for reservations"))!;
    expect(held.textContent).toContain("70 GB");
    expect(legend.textContent).toContain("184 of 200 GB");
    expect(text()).toContain("350 GB reserved");
    expect(text()).toContain("of 1 TB · 70%");
    expect(text()).not.toContain("Free in the pool");
  });

  it("two members with the same name keep their own colours: rows match usage by user id", async () => {
    const f = reservedFamily();
    // Both called Sam. The usage list ranks the second Sam (sam_b, 96 GB) above the first (sam_a, 10 GB).
    const members = [
      { id: "fm_a", email: "sam.a@example.com", name: "Sam", status: "active", joined_at: 1, expires_at: null, reserved_bytes: null, used_bytes: 10 * GBn, max_reservable_bytes: 100 * GBn, user_id: "sam_a" },
      { id: "fm_b", email: "sam.b@example.com", name: "Sam", status: "active", joined_at: 1, expires_at: null, reserved_bytes: null, used_bytes: 96 * GBn, max_reservable_bytes: 100 * GBn, user_id: "sam_b" },
    ];
    const usage = [
      { id: "u_alex", name: "Alex", is_you: true, is_payer: true, used_bytes: 310 * GBn, used_label: "310 GB", reserved_bytes: null },
      { id: "sam_b", name: "Sam", is_you: false, is_payer: false, used_bytes: 96 * GBn, used_label: "96 GB", reserved_bytes: null },
      { id: "sam_a", name: "Sam", is_you: false, is_payer: false, used_bytes: 10 * GBn, used_label: "10 GB", reserved_bytes: null },
    ];
    getFamily.mockResolvedValue({ ...f, members, usage, pool: { ...f.pool, reserved_bytes: 0, held_bytes: 0 } });
    await mount();
    const norm = (color: string) => { const el = document.createElement("span"); el.style.background = color; return el.style.background; };
    const avatarOf = (email: string) => ([...document.body.querySelectorAll("li")].find((li) => li.querySelector("[title]")?.getAttribute("title") === email)!
      .querySelector('[data-slot="avatar"]') as HTMLElement).style.background;
    expect(avatarOf("sam.b@example.com")).toBe(norm(personColor(1, false)));
    expect(avatarOf("sam.a@example.com")).toBe(norm(personColor(2, false)));
  });

  it("a reservation line uses one number format on both sides (whole GB, grouped)", async () => {
    const f = reservedFamily();
    getFamily.mockResolvedValue({ ...f, members: f.members.map((m) => m.id === "fm_e" ? { ...m, used_bytes: 1234.4 * GBn, reserved_bytes: 2000 * GBn } : m.id === "fm_s" ? { ...m, used_bytes: 7.6 * GBn } : m) });
    await mount();
    expect(rowOf("Emma").textContent).toContain("1,234 of 2,000 GB reserved");
    expect(rowOf("Sam").textContent).toContain("8 of 150 GB reserved");
  });

  it("the web link still shows for a payer who can buy places", async () => {
    getFamily.mockResolvedValue(reservedFamily({ can_buy_places: true }));
    await mount(true);
    expect(text()).toContain("Manage places on the web");
    expect(text()).not.toMatch(/Add places|Purchase/);
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
