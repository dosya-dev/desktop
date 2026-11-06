// The live chat REST surface, as apps/web/src/api/support-chat.ts but over the
// desktop api client (cookie session, app://bundle origin).
import { api, apiBase } from "@/lib/api-client";
import type { ChatAttachment, ChatMessage, ChatSummary, Conversation, Rating } from "./types";

export interface ChatSummaryResult {
  available: boolean;
  chat: ChatSummary | null;
  /** The active conversation (null before the first one, or when the room could not be asked). */
  conversation: Conversation | null;
  persona_online: boolean;
  staff_online: boolean;
  unread: number;
}

export function fetchChatSummary(): Promise<ChatSummaryResult> {
  return api.get<{
    ok: boolean; available?: boolean; chat: ChatSummary | null; conversation?: Conversation | null;
    persona_online?: boolean; staff_online: boolean; unread: number;
  }>("/api/support/chat").then((r) => ({
    available: r.available !== false,
    chat: r.chat,
    conversation: r.conversation ?? null,
    persona_online: !!r.persona_online,
    staff_online: !!r.staff_online,
    unread: r.unread ?? 0,
  }));
}

export function fetchChatMessages(after?: number): Promise<ChatMessage[]> {
  const q = after ? `?after=${after}` : "";
  return api.get<{ ok: boolean; messages: ChatMessage[] }>(`/api/support/chat/messages${q}`).then((r) => r.messages);
}

export function postChatMessage(input: { id: string; body: string; attachment_ids?: string[] }): Promise<ChatMessage> {
  return api.post<{ ok: boolean; message: ChatMessage }>("/api/support/chat/messages", input).then((r) => r.message);
}

export function postChatSeen(): Promise<void> {
  return api.post("/api/support/chat/seen").then(() => undefined);
}

/** A past or current conversation as the history list shows it. */
export type ConversationListItem = Conversation & { title: string | null; last_message_at: number };

export function fetchConversations(): Promise<ConversationListItem[]> {
  return api.get<{ ok: boolean; conversations: ConversationListItem[] }>("/api/support/chat/conversations").then((r) => r.conversations);
}

/** One conversation's messages, read-only (the caller's own only). */
export function fetchConversationMessages(id: string): Promise<ChatMessage[]> {
  return api.get<{ ok: boolean; messages: ChatMessage[] }>(`/api/support/chat/messages?conversation=${encodeURIComponent(id)}`)
    .then((r) => r.messages);
}

export function endConversation(): Promise<Conversation> {
  return api.post<{ ok: boolean; conversation: Conversation }>("/api/support/chat/end").then((r) => r.conversation);
}

export function startConversation(): Promise<Conversation> {
  return api.post<{ ok: boolean; conversation: Conversation }>("/api/support/chat/start").then((r) => r.conversation);
}

/** Rates the active conversation, or `conversation_id` when given. 409 `not_ended` / `rating_closed` arrive as ApiError. */
export function postRating(input: { stars: number; solved: boolean; comment?: string; conversation_id?: string }): Promise<Rating> {
  return api.post<{ ok: boolean; rating: Rating }>("/api/support/chat/rating", input).then((r) => r.rating);
}

export async function uploadChatImages(files: File[]): Promise<ChatAttachment[]> {
  const fd = new FormData();
  for (const f of files) fd.append("images", f);
  const res = await api.post<{ ok: boolean; attachments: ChatAttachment[] }>("/api/support/chat/attachments", fd);
  return res.attachments;
}

export function chatAttachmentUrl(id: string): string {
  return `${apiBase()}/api/support/chat/attachments/${id}`;
}

export function chatSocketUrl(): string {
  return `${apiBase().replace(/^http/, "ws")}/api/support/chat/socket`;
}

export function personaAvatarUrl(path: string): string {
  return `${apiBase()}${path}`;
}
