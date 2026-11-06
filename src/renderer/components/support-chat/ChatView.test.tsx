import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api-client")>()),
  apiBase: () => "https://api.example",
}));
vi.mock("../../lib/support-chat/sounds", () => ({
  playSend: vi.fn(), playReceive: vi.fn(), isMuted: vi.fn(() => false), setMuted: vi.fn(),
}));

const { ChatView } = await import("./ChatView");
const { __setClientFactory, useSupportChat } = await import("../../lib/support-chat/store");

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onBack = vi.fn();

beforeEach(() => {
  __setClientFactory(() => ({ connect() {}, close() {}, send() {}, sendMessage: () => "m", discard() {} }) as never);
  useSupportChat.getState().__reset();
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  __setClientFactory(null);
});

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<ChatView onBack={onBack} />); });
}
const text = () => document.body.textContent ?? "";

describe("ChatView", () => {
  it("counts as on screen while mounted and shows the composer for an open conversation", async () => {
    await mount();
    expect(useSupportChat.getState().chatOpen).toBe(true);
    expect(text()).toContain("dosya support");
    expect(document.querySelector("textarea")).not.toBeNull();
    act(() => root!.unmount());
    root = null;
    expect(useSupportChat.getState().chatOpen).toBe(false);
  });

  it("shows the rating card and a new-conversation button once the conversation ended", async () => {
    useSupportChat.setState({
      conversation: { id: "c1", status: "ended", persona: null, ended_by: "user", ended_at: Math.floor(Date.now() / 1000), rating: null, started_at: 1 },
    });
    await mount();
    expect(text()).toContain("How was your chat?");
    expect(text()).toContain("Start a new conversation");
    expect(document.querySelector("textarea[placeholder='Write a message…']")).toBeNull();
  });

  it("support replies and the header carry the dosya logo when no persona photo is set", async () => {
    useSupportChat.setState({
      messages: [{
        id: "m1", chat_id: "c1", author_type: "staff", author_id: "s", author_name: "Carl", kind: "text", persona_id: null,
        body: "Hi there", meta: null, attachments: [], created_at: Math.floor(Date.now() / 1000), persona: null,
      }],
    });
    await mount();
    // One in the header, one beside the reply.
    expect(document.querySelectorAll("[data-testid='support-logo-avatar']").length).toBe(2);
  });

  it("a persona with a photo shows the photo, not the logo", async () => {
    useSupportChat.setState({ persona: { id: "p1", name: "Carl", title: null, avatar_url: "/api/support/personas/p1/avatar", active: true } });
    await mount();
    expect(document.querySelector("header img")?.getAttribute("src")).toBe("https://api.example/api/support/personas/p1/avatar");
    expect(document.querySelector("header [data-testid='support-logo-avatar']")).toBeNull();
  });

  it("always reads as available, even when no staff are connected", async () => {
    useSupportChat.setState({ staffOnline: false, personaOnline: false });
    await mount();
    expect(text()).toContain("Online");
    expect(text()).not.toMatch(/away/i);
  });

  it("Back returns to Help & contact", async () => {
    await mount();
    const back = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Help"))!;
    await act(async () => back.click());
    expect(onBack).toHaveBeenCalled();
  });
});
