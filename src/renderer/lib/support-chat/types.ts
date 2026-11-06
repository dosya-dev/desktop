// Hand copy of apps/web/src/lib/support-chat/types.ts (itself a copy of the api one); keep in step.
// Shared by the api, apps/admin and (copied by hand) apps/web. Keep this file
// import-free.
export type ChatStatus = "waiting" | "answered" | "ended";
export type AuthorType = "user" | "staff" | "system";
export type MessageKind = "text" | "ticket_created" | "closed" | "file_share" | "grant_revoked" | "persona_joined";
export interface ChatAttachment { id: string; file_name: string; content_type: string; size_bytes: number }
export interface ChatMessage { id: string; chat_id: string; author_type: AuthorType; author_id: string | null; author_name: string | null; kind: MessageKind; persona_id: string | null; body: string; meta: Record<string, unknown> | null; attachments: ChatAttachment[]; created_at: number }
export interface ChatSummary { id: string; user_id: string; status: ChatStatus; last_message_at: number; last_user_message_at: number | null; last_staff_message_at: number | null; user_last_seen_at: number | null; staff_last_seen_at: number | null; created_at: number; persona_id: string | null; ended_by: "user" | "staff" | null; ended_at: number | null; title: string | null }
export interface Persona { id: string; name: string; title: string | null; avatar_url: string | null; active: boolean }
export interface Conversation { id: string; status: ChatStatus; persona: Persona | null; ended_by: "user" | "staff" | null; ended_at: number | null; rating: Rating | null; started_at: number }
export interface Rating { stars: number; solved: boolean; comment: string | null; created_at: number }
// A message as the room sends it live: the stored row plus its persona, resolved from persona_id.
export type LiveMessage = ChatMessage & { persona: Persona | null };
export const personaUrl = (id: string): string => `/api/support/personas/${id}/avatar`;
export interface ChatDiagnostics { v: 1; client: "web" | "desktop" | "mobile"; app_version: string; build: string | null; platform: string; locale: string | null; workspace_id: string | null; page: string | null; error_ref: string | null; error_message: string | null; captured_at: number }
// client -> room
export type ClientFrame =
  | { v: 1; type: "hello"; diagnostics?: ChatDiagnostics }
  | { v: 1; type: "message"; id: string; body: string; attachment_ids?: string[] }
  | { v: 1; type: "delivered"; message_id: string }
  | { v: 1; type: "seen"; last_message_id: string }
  | { v: 1; type: "typing"; on: boolean }
  | { v: 1; type: "end" }
  | { v: 1; type: "start" }
  | { v: 1; type: "rate"; stars: number; solved: boolean; comment?: string };
// room -> client
export type ServerFrame =
  | { v: 1; type: "ready"; chat_id: string; staff_online: boolean; persona_online: boolean; conversation: Conversation; messages: LiveMessage[]; unread: number }
  | { v: 1; type: "message"; message: LiveMessage }
  | { v: 1; type: "ack"; id: string; message: LiveMessage }
  | { v: 1; type: "seen"; by: "user" | "staff"; at: number }
  | { v: 1; type: "typing"; by: "user" | "staff"; on: boolean; persona_name: string | null }
  | { v: 1; type: "conversation"; conversation: Conversation }
  | { v: 1; type: "presence"; staff_online: boolean; persona_online: boolean; persona: Persona | null }
  | { v: 1; type: "error"; code: "bad_frame" | "too_long" | "rate_limited" | "not_available" | "too_many_attachments" | "conversation_ended" | "rating_closed" | "not_ended" | "too_many_conversations" | "persona_required" | "conversation_empty"; message: string };
export type SocketRole = "user" | "staff";
export interface SocketAttachment { role: SocketRole; actorId: string; actorName: string }
export const CHAT_LIMITS = { bodyBytes: 10_240, messagesPerMinute: 30, attachmentsPerMessage: 10, socketsPerUser: 5, readyMessages: 50 } as const;
export const CHAT_CLOSE_NOT_AVAILABLE = 4403;
