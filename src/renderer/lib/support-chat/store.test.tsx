import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  fetchChatSummary: vi.fn(),
  fetchChatMessages: vi.fn(async () => []),
  postChatMessage: vi.fn(),
  postChatSeen: vi.fn(async () => undefined),
  uploadChatImages: vi.fn(),
  chatSocketUrl: () => "wss://x/socket",
  fetchConversations: vi.fn(async () => []),
  fetchConversationMessages: vi.fn(async () => []),
  endConversation: vi.fn(),
  startConversation: vi.fn(),
  postRating: vi.fn(),
}));
vi.mock("./sounds", () => ({
  playSend: vi.fn(), playReceive: vi.fn(),
  isMuted: vi.fn(() => false), setMuted: vi.fn(),
}));

import * as rest from "./api";
import * as sounds from "./sounds";
import { ApiError } from "@/lib/api-client";
import { restErrorCode, type ClientEvent } from "./client";
import { __setClientFactory, supportChatEnabled, useSupportChat } from "./store";
import type { ClientFrame, Conversation, LiveMessage, ServerFrame } from "./types";

class FakeClient {
  connects = 0; closes = 0; sent: ClientFrame[] = []; discarded: string[] = [];
  messages: { id: string; body: string; ids?: string[] }[] = [];
  constructor(public onEvent: (e: ClientEvent) => void) {}
  connect() { this.connects++; }
  close() { this.closes++; }
  send(f: ClientFrame) { this.sent.push(f); }
  sendMessage(body: string, ids?: string[], id = "msg_fixed") { this.messages.push({ id, body, ids }); return id; }
  discard(id: string) { this.discarded.push(id); }
  frame(frame: ServerFrame) { this.onEvent({ type: "frame", frame }); }
}

let fake: FakeClient | null;
let created = 0;
let focused = true;
const notify = vi.fn();
const conv = (id: string, over: Partial<Conversation> = {}): Conversation => ({ id, status: "answered", persona: null, ended_by: null, ended_at: null, rating: null, started_at: 1, ...over });
const staffMsg = (id: string, body = "hello"): LiveMessage => ({
  id, chat_id: "c1", author_type: "staff", author_id: "s", author_name: "Carl", kind: "text",
  persona_id: "p1", body, meta: null, attachments: [], created_at: 10,
  persona: { id: "p1", name: "Carl", title: null, avatar_url: null, active: true },
});
const summary = (over: Partial<Awaited<ReturnType<typeof rest.fetchChatSummary>>> = {}) => ({
  available: true, chat: null, conversation: null, persona_online: false, staff_online: true, unread: 0, ...over,
});
const flush = () => new Promise<void>((r) => queueMicrotask(r)).then(() => Promise.resolve());

beforeEach(() => {
  created = 0;
  fake = null;
  focused = true;
  vi.clearAllMocks();
  document.title = "dosya";
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { showSupportChatNotification: notify, getAppVersion: vi.fn(async () => "3.1.5") },
  });
  __setClientFactory((onEvent) => { created++; fake = new FakeClient(onEvent); return fake as never; });
  useSupportChat.getState().__reset();
});
afterEach(() => { __setClientFactory(null); vi.restoreAllMocks(); });

describe("desktop support chat store", () => {
  it("reads the feature flag loosely from the session user", () => {
    expect(supportChatEnabled({ features: { support_chat: true } })).toBe(true);
    expect(supportChatEnabled({ id: "u" })).toBe(false);
    expect(supportChatEnabled(null)).toBe(false);
  });

  it("boot without an active conversation opens no socket", async () => {
    vi.mocked(rest.fetchChatSummary).mockResolvedValue(summary());
    useSupportChat.getState().boot();
    await flush();
    expect(created).toBe(0);
  });

  it("boot with an active conversation connects, and unread from the summary raises the title count", async () => {
    vi.mocked(rest.fetchChatSummary).mockResolvedValue(summary({ conversation: conv("c1"), unread: 2 }));
    useSupportChat.getState().boot();
    await flush();
    expect(created).toBe(1);
    expect(useSupportChat.getState().unread).toBe(2);
    expect(document.title).toBe("(2) dosya");
  });

  it("an ended conversation does not keep a socket open", async () => {
    vi.mocked(rest.fetchChatSummary).mockResolvedValue(summary({ conversation: conv("c1", { status: "ended" }) }));
    useSupportChat.getState().boot();
    await flush();
    expect(created).toBe(0);
  });

  it("a reply while the chat is not on screen raises every cue; a system notification only when unfocused", async () => {
    vi.mocked(rest.fetchChatSummary).mockResolvedValue(summary({ conversation: conv("c1") }));
    useSupportChat.getState().boot();
    await flush();
    fake!.frame({ v: 1, type: "message", message: staffMsg("m1", "Can you send a screenshot?") });
    let st = useSupportChat.getState();
    expect(st.unread).toBe(1);
    expect(st.lastReply).toEqual({ name: "Carl", body: "Can you send a screenshot?" });
    expect(document.title).toBe("(1) dosya");
    expect(sounds.playReceive).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();

    focused = false;
    fake!.frame({ v: 1, type: "message", message: staffMsg("m2", "Still there?") });
    st = useSupportChat.getState();
    expect(st.unread).toBe(2);
    expect(document.title).toBe("(2) dosya");
    expect(notify).toHaveBeenCalledWith({ title: "Carl", body: "Still there?" });
  });

  it("showing the chat clears the cues and reports seen; hiding it keeps the socket", async () => {
    vi.mocked(rest.fetchChatSummary).mockResolvedValue(summary({ conversation: conv("c1") }));
    useSupportChat.getState().boot();
    await flush();
    fake!.frame({ v: 1, type: "message", message: staffMsg("m1") });
    useSupportChat.getState().showChat(true);
    expect(useSupportChat.getState().unread).toBe(0);
    expect(useSupportChat.getState().lastReply).toBeNull();
    expect(document.title).toBe("dosya");
    expect(fake!.sent.at(-1)).toEqual({ v: 1, type: "seen", last_message_id: "m1" });
    useSupportChat.getState().showChat(false);
    expect(fake!.closes).toBe(0);
    expect(created).toBe(1);
  });

  it("a reply while the chat is on screen in a focused window is seen at once", () => {
    useSupportChat.getState().showChat(true);
    fake!.frame({ v: 1, type: "message", message: staffMsg("m1") });
    expect(useSupportChat.getState().unread).toBe(0);
    expect(fake!.sent).toContainEqual({ v: 1, type: "seen", last_message_id: "m1" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a ready frame with unread while the chat is elsewhere raises the cues with the last reply", () => {
    useSupportChat.getState().showChat(true);
    useSupportChat.getState().showChat(false);
    fake!.frame({
      v: 1, type: "ready", chat_id: "c1", staff_online: true, persona_online: true,
      conversation: conv("c1"), messages: [staffMsg("m1", "We fixed it")], unread: 1,
    });
    expect(useSupportChat.getState().lastReply).toEqual({ name: "Carl", body: "We fixed it" });
    expect(document.title).toBe("(1) dosya");
  });

  it("image sends show at once with previews, then go out with the uploaded ids", async () => {
    let finish!: (a: Awaited<ReturnType<typeof rest.uploadChatImages>>) => void;
    vi.mocked(rest.uploadChatImages).mockReturnValue(new Promise((r) => { finish = r; }));
    useSupportChat.getState().showChat(true);
    const done = useSupportChat.getState().send("pic", [new File(["x"], "a.png", { type: "image/png" })]);
    const row = useSupportChat.getState().messages.at(-1)!;
    expect(row.previews?.[0].name).toBe("a.png");
    expect(useSupportChat.getState().pending[row.id]).toBe("uploading");
    finish([{ id: "att1", file_name: "a.png", content_type: "image/png", size_bytes: 1 }]);
    await done;
    expect(fake!.messages[0]).toMatchObject({ id: row.id, body: "pic", ids: ["att1"] });
  });

  it("a failed upload removes the row and returns the text", async () => {
    vi.mocked(rest.uploadChatImages).mockRejectedValue(new ApiError("boom", 500));
    useSupportChat.getState().showChat(true);
    await useSupportChat.getState().send("pic", [new File(["x"], "a.png", { type: "image/png" })]);
    expect(useSupportChat.getState().messages).toHaveLength(0);
    expect(useSupportChat.getState().lastFailedDraft).toBe("pic");
  });

  it("reset (sign-out) closes the socket and restores the title", async () => {
    vi.mocked(rest.fetchChatSummary).mockResolvedValue(summary({ conversation: conv("c1"), unread: 3 }));
    useSupportChat.getState().boot();
    await flush();
    const client = fake!;
    useSupportChat.getState().__reset();
    expect(client.closes).toBe(1);
    expect(document.title).toBe("dosya");
    expect(useSupportChat.getState().booted).toBe(false);
  });

  it("restErrorCode reads the chat code from the desktop ApiError data", () => {
    expect(restErrorCode(new ApiError("x", 409, { ok: false, error: "conversation_empty" }))).toBe("conversation_empty");
    expect(restErrorCode(new ApiError("x", 409, { error: "something_else" }))).toBeNull();
    expect(restErrorCode(new Error("x"))).toBeNull();
  });
});
