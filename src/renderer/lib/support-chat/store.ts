import { create } from 'zustand';
import { ApiError } from '@/lib/api-client';
import {
  chatSocketUrl,
  endConversation as restEndConversation,
  fetchChatMessages,
  fetchChatSummary,
  fetchConversationMessages,
  fetchConversations,
  postChatMessage,
  postChatSeen,
  postRating,
  startConversation as restStartConversation,
  uploadChatImages,
  type ConversationListItem,
} from './api';
import {
  newMessageId,
  restErrorCode,
  SupportChatClient,
  type ChatErrorCode,
  type ClientEvent,
  type ConnState,
} from './client';
import { isMuted, playReceive, playSend, setMuted } from './sounds';
import { clearAttention, notifyReply, setAttention } from './attention';
import type { ChatDiagnostics, ChatMessage, ClientFrame, Conversation, Persona, ServerFrame } from './types';

// Port of apps/web/src/stores/support-chat.ts for the desktop app. Differences:
// the chat lives in Profile > Help & contact (no panel), and the socket stays
// connected while the app runs once there is an active conversation (boot()),
// so a reply reaches the user on any page. The room DO hibernates idle sockets.
// This store is the one owner of the chat's cues (sounds, tab title, favicon dot):
// the Profile chat view and the Help & contact row only render its state.

/** A local image shown on an own row before (and after) its upload lands. */
export interface LocalPreview { key: string; url: string; name: string }
/**
 * A thread row: live messages carry their persona, REST and optimistic rows may not.
 * `previews` are the sender's own images as object URLs, kept after the ack so they do not reload.
 */
export type ThreadMessage = ChatMessage & { persona?: Persona | null; previews?: LocalPreview[] };
/** uploading: images are on their way to the api and no frame has left yet. */
export type PendingState = 'uploading' | 'sending' | 'sent';
/**
 * Conversation-level refusals (start cap, rating window, rating too early, ending or rating an
 * empty conversation). They never fail a pending message; the UI explains the ones it can.
 */
export type ConversationError = Extract<ChatErrorCode, 'too_many_conversations' | 'not_ended' | 'rating_closed' | 'conversation_empty'>;

const ACK_TIMEOUT_MS = 15_000;
const CONVERSATION_ERRORS: ReadonlySet<string> = new Set<ConversationError>(['too_many_conversations', 'not_ended', 'rating_closed', 'conversation_empty']);

interface ChatClient {
  connect(): void;
  close(): void;
  send(frame: ClientFrame): void;
  sendMessage(body: string, attachmentIds?: string[], id?: string): string;
  discard(id: string): void;
}
type ClientFactory = (onEvent: (e: ClientEvent) => void) => ChatClient;

const defaultFactory: ClientFactory = (onEvent) =>
  new SupportChatClient({
    socketUrl: chatSocketUrl,
    rest: {
      fetchMessages: fetchChatMessages,
      postMessage: postChatMessage,
      postSeen: postChatSeen,
      endConversation: restEndConversation,
      startConversation: restStartConversation,
      postRating,
    },
    onEvent,
    diagnostics: () => diagnostics(),
  });

let factory: ClientFactory = defaultFactory;

let appVersion = 'desktop';
/** Called once at boot so the hello frame can name the app version synchronously. */
function primeAppVersion(): void {
  try {
    void window.electronAPI.getAppVersion().then((v) => { if (typeof v === 'string' && v) appVersion = v; }).catch(() => {});
  } catch { /* tests and odd shells have no bridge */ }
}
function diagnostics(): ChatDiagnostics {
  return {
    v: 1, client: 'desktop', app_version: appVersion, build: null,
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'desktop',
    locale: typeof navigator !== 'undefined' ? navigator.language : null,
    workspace_id: null, page: typeof location !== 'undefined' ? location.hash || location.pathname : null,
    error_ref: null, error_message: null, captured_at: Date.now(),
  };
}
/** Test seam: swap the client factory; null restores the real one. */
export function __setClientFactory(f: ClientFactory | null): void {
  factory = f ?? defaultFactory;
}

let client: ChatClient | null = null;

// jsdom and some embedded webviews lack object URLs; the row then shows file names only.
function previewUrl(f: File): string {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(f) : '';
}
function revokePreview(url: string): void {
  if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}
const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Seen needs the chat on screen in the focused window: a reply that lands while
// the app sits behind another window still raises the cues.
const visible = () => typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus());

/**
 * The server admits this user to live chat (/api/me user.features.support_chat).
 * Read loosely: the shared User type does not carry server feature flags.
 */
export function supportChatEnabled(user: unknown): boolean {
  return !!(user as { features?: { support_chat?: unknown } } | null)?.features?.support_chat;
}

/** The newest unseen reply, for the Help & contact row. */
export interface ReplyExcerpt { name: string | null; body: string }

interface SupportChatState {
  /** The chat view is mounted in Profile > Help & contact. */
  chatOpen: boolean;
  /** boot() ran with the feature on (logout resets it). */
  booted: boolean;
  lastReply: ReplyExcerpt | null;
  conn: ConnState;
  staffOnline: boolean;
  unread: number;
  /** Unix seconds when staff last saw the thread; drives the Seen label. */
  staffSeenAt: number;
  messages: ThreadMessage[];
  typing: boolean;
  /** The persona typing, when staff answer as one. */
  typingName: string | null;
  notAvailable: boolean;
  pending: Record<string, PendingState>;
  /** Text of a message that failed to send, for the composer to restore. */
  lastFailedDraft: string | null;
  /** The active conversation (null until the room or the summary has said). */
  conversation: Conversation | null;
  /** Who is answering the active conversation; null shows "dosya support". */
  persona: Persona | null;
  personaOnline: boolean;
  /** Past and current conversations, newest first (loaded on demand). */
  history: ConversationListItem[];
  /** A history conversation shown read-only, or null for the active one. */
  viewing: string | null;
  historyMessages: ChatMessage[];
  muted: boolean;
  lastError: ConversationError | null;
  /** The feature is on for this user: read the summary and connect when a conversation is active. */
  boot: () => void;
  /** The chat view mounted (true) or unmounted (false). The socket stays up either way. */
  showChat: (on: boolean) => void;
  refreshSummary: () => Promise<void>;
  send: (body: string, files: File[]) => Promise<void>;
  markSeen: () => void;
  setTyping: (on: boolean) => void;
  clearFailedDraft: () => void;
  endConversation: () => void;
  startConversation: () => void;
  rate: (stars: number, solved: boolean, comment: string) => Promise<void>;
  loadHistory: () => Promise<void>;
  viewConversation: (id: string | null) => Promise<void>;
  toggleMute: () => void;
  clearError: () => void;
  __reset: () => void;
}

const initial = () => ({
  conn: 'idle' as ConnState,
  staffOnline: false,
  unread: 0,
  staffSeenAt: 0,
  messages: [] as ThreadMessage[],
  typing: false,
  typingName: null as string | null,
  notAvailable: false,
  pending: {} as Record<string, PendingState>,
  lastFailedDraft: null as string | null,
  conversation: null as Conversation | null,
  persona: null as Persona | null,
  personaOnline: false,
  history: [] as ConversationListItem[],
  viewing: null as string | null,
  historyMessages: [] as ChatMessage[],
  lastError: null as ConversationError | null,
  chatOpen: false,
  booted: false,
  lastReply: null as ReplyExcerpt | null,
});

export const useSupportChat = create<SupportChatState>((set, get) => {
  function ensureClient(): ChatClient {
    if (client) return client;
    client = factory(onEvent);
    client.connect();
    return client;
  }

  function clearAckTimers(): void {
    for (const t of ackTimers.values()) clearTimeout(t);
    ackTimers.clear();
  }

  function disconnect(): void {
    client?.close();
    client = null;
    clearAckTimers();
    set({ conn: 'idle', typing: false, typingName: null, pending: {} });
  }

  /** The active thread is on screen in the focused window. */
  function isSeen(): boolean {
    const { chatOpen, viewing } = get();
    return visible() && viewing === null && chatOpen;
  }

  function lastStaff(): ThreadMessage | undefined {
    return [...get().messages].reverse().find((m) => m.author_type === 'staff');
  }

  function reportSeen(): void {
    const m = lastStaff();
    if (m && client) client.send({ v: 1, type: 'seen', last_message_id: m.id });
  }

  /** Seen: tell the room, zero unread, drop the tab cues. */
  function seenNow(): void {
    reportSeen();
    set({ unread: 0, lastReply: null });
    clearAttention();
  }

  function mergeMessages(incoming: ThreadMessage[]): ThreadMessage[] {
    const byId = new Map(get().messages.map((m) => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
  }

  function failPending(id: string): void {
    const t = ackTimers.get(id);
    if (t) clearTimeout(t);
    ackTimers.delete(id);
    const { pending, messages } = get();
    if (pending[id] !== 'sending') return;
    const failed = messages.find((m) => m.id === id);
    failed?.previews?.forEach((p) => revokePreview(p.url));
    const { [id]: _drop, ...rest } = pending;
    client?.discard(id);
    set({ pending: rest, messages: messages.filter((m) => m.id !== id), lastFailedDraft: failed?.body ?? null });
  }

  /** Removes an own row that never left (failed or abandoned upload) and frees its previews. */
  function dropRow(id: string): void {
    const row = get().messages.find((m) => m.id === id);
    row?.previews?.forEach((p) => revokePreview(p.url));
    const { [id]: _drop, ...rest } = get().pending;
    set({ pending: rest, messages: get().messages.filter((m) => m.id !== id) });
  }

  function failNewestPending(): void {
    const sending = Object.keys(get().pending).filter((id) => get().pending[id] === 'sending');
    const newest = sending[sending.length - 1];
    if (newest) failPending(newest);
  }

  /** A different conversation became active: the old thread and its cues go. */
  function resetThread(): void {
    clearAckTimers();
    set({ messages: [], pending: {}, unread: 0, typing: false, typingName: null, staffSeenAt: 0 });
    clearAttention();
  }

  function applyConversation(c: Conversation): void {
    const prev = get().conversation;
    if (prev && prev.id !== c.id) resetThread();
    set({ conversation: c, persona: c.persona });
  }

  function onFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'ready':
        applyConversation(frame.conversation);
        set({
          staffOnline: frame.staff_online,
          personaOnline: frame.persona_online,
          unread: frame.unread,
          notAvailable: false,
          messages: mergeMessages(frame.messages),
        });
        if (frame.unread > 0) {
          if (isSeen()) seenNow();
          else raiseCues(frame.unread);
        }
        break;
      case 'message': {
        const m = frame.message;
        if (get().messages.some((x) => x.id === m.id)) break;
        set({ messages: mergeMessages([m]) });
        if (m.author_type !== 'staff') break;
        if (!get().muted) playReceive();
        if (isSeen()) {
          client?.send({ v: 1, type: 'delivered', message_id: m.id });
          client?.send({ v: 1, type: 'seen', last_message_id: m.id });
        } else {
          const unread = get().unread + 1;
          const name = m.persona?.name ?? get().persona?.name ?? null;
          const body = m.body.trim() || (m.attachments.length > 0 ? '📎' : '');
          set({ unread, lastReply: { name, body } });
          setAttention(unread);
          notifyReply(name ?? 'dosya support', body);
        }
        break;
      }
      case 'ack': {
        const t = ackTimers.get(frame.id);
        if (t) clearTimeout(t);
        ackTimers.delete(frame.id);
        const previews = get().messages.find((m) => m.id === frame.id)?.previews;
        const messages = get().messages.filter((m) => m.id !== frame.id);
        const acked: ThreadMessage = previews ? { ...frame.message, previews } : frame.message;
        set({
          messages: [...messages, acked].sort((a, b) => a.created_at - b.created_at),
          pending: { ...get().pending, [frame.id]: 'sent' },
        });
        break;
      }
      case 'typing':
        if (frame.by === 'staff') set({ typing: frame.on, typingName: frame.on ? frame.persona_name : null });
        break;
      case 'presence':
        set({
          staffOnline: frame.staff_online,
          personaOnline: frame.persona_online,
          persona: frame.persona ?? get().conversation?.persona ?? null,
        });
        break;
      case 'conversation':
        applyConversation(frame.conversation);
        break;
      case 'seen':
        if (frame.by === 'staff') set({ staffSeenAt: frame.at });
        break;
      case 'error': {
        if (frame.code === 'not_available') {
          set({ notAvailable: true });
          break;
        }
        if (CONVERSATION_ERRORS.has(frame.code)) {
          set({ lastError: frame.code as ConversationError });
          break;
        }
        if (frame.code === 'persona_required') break; // staff only
        failNewestPending();
        // The message landed on an ended conversation (staff ended it meanwhile): catch up.
        if (frame.code === 'conversation_ended') void get().refreshSummary();
        break;
      }
    }
  }

  function onEvent(e: ClientEvent): void {
    if (e.type === 'state') {
      set({ conn: e.state });
      return;
    }
    onFrame(e.frame);
  }

  /** Unread from a snapshot (ready frame or summary): count, title and the row excerpt, no sound. */
  function raiseCues(unread: number): void {
    const last = lastStaff();
    set({ unread, lastReply: last ? { name: last.persona?.name ?? get().persona?.name ?? null, body: last.body.trim() } : get().lastReply });
    setAttention(unread);
  }

  /** Talk to the room whenever a conversation is open, so replies arrive on any page. */
  function connectIfActive(): void {
    const c = get().conversation;
    if (get().booted && c && c.status !== 'ended') ensureClient();
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (isSeen()) seenNow();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      if (!get().booted) return;
      if (isSeen()) seenNow();
      // Not connected (no active conversation when the app started): catch up from the summary.
      if (!client) void get().refreshSummary();
    });
  }

  return {
    ...initial(),
    muted: isMuted(),

    boot: () => {
      if (get().booted) return;
      set({ booted: true });
      primeAppVersion();
      void get().refreshSummary();
    },

    showChat: (on) => {
      set({ chatOpen: on });
      if (!on) return;
      ensureClient();
      if (isSeen()) seenNow();
    },

    refreshSummary: async () => {
      try {
        const r = await fetchChatSummary();
        if (r.conversation) applyConversation(r.conversation);
        set({
          staffOnline: r.staff_online, personaOnline: r.persona_online, notAvailable: !r.available,
          staffSeenAt: Math.max(get().staffSeenAt, r.chat?.staff_last_seen_at ?? 0),
        });
        if (r.unread > 0 && !isSeen()) raiseCues(r.unread);
        else if (r.unread === 0 && !client) set({ unread: 0 });
        connectIfActive();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) set({ notAvailable: true });
      }
    },

    send: async (body, files) => {
      const c = ensureClient();
      const id = newMessageId();
      const previews: LocalPreview[] = files.map((f, i) => ({ key: `${id}:${i}`, url: previewUrl(f), name: f.name }));
      // The row shows at once, images included; the upload runs behind it. Pending and the
      // optimistic row exist before the frame leaves, so an ack cannot beat them.
      const optimistic: ThreadMessage = {
        id, chat_id: '', author_type: 'user', author_id: null, author_name: null, kind: 'text', persona_id: null,
        body, meta: null, attachments: [], created_at: Math.floor(Date.now() / 1000), persona: null,
        ...(previews.length > 0 ? { previews } : {}),
      };
      set({
        pending: { ...get().pending, [id]: files.length > 0 ? 'uploading' : 'sending' },
        messages: [...get().messages, optimistic],
        lastFailedDraft: null,
      });
      if (!get().muted) playSend();

      let ids: string[] | undefined;
      if (files.length > 0) {
        try {
          ids = (await uploadChatImages(files)).map((a) => a.id);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) set({ notAvailable: true });
          dropRow(id);
          set({ lastFailedDraft: body });
          return;
        }
        // The thread was reset (sign-out, another conversation) while uploading: the row is gone, send nothing.
        if (get().pending[id] !== 'uploading' || client !== c) {
          dropRow(id);
          return;
        }
        set({ pending: { ...get().pending, [id]: 'sending' } });
      }
      ackTimers.set(id, setTimeout(() => failPending(id), ACK_TIMEOUT_MS));
      c.sendMessage(body, ids, id);
    },

    markSeen: () => {
      set({ unread: 0 });
      clearAttention();
      if (isSeen()) reportSeen();
    },

    setTyping: (on) => {
      client?.send({ v: 1, type: 'typing', on });
    },

    clearFailedDraft: () => set({ lastFailedDraft: null }),

    endConversation: () => {
      ensureClient().send({ v: 1, type: 'end' });
    },

    startConversation: () => {
      set({ viewing: null, historyMessages: [], lastError: null });
      ensureClient().send({ v: 1, type: 'start' });
    },

    rate: async (stars, solved, comment) => {
      const text = comment.trim();
      const extra = text ? { comment: text } : {};
      const viewing = get().viewing;
      if (viewing === null || viewing === get().conversation?.id) {
        // The room answers with a conversation frame carrying the rating.
        ensureClient().send({ v: 1, type: 'rate', stars, solved, ...extra });
        return;
      }
      // A past conversation: REST names it; the socket only rates the active one.
      try {
        const rating = await postRating({ stars, solved, ...extra, conversation_id: viewing });
        set({ history: get().history.map((h) => (h.id === viewing ? { ...h, rating } : h)), lastError: null });
      } catch (err) {
        const code = restErrorCode(err);
        if (code && CONVERSATION_ERRORS.has(code)) set({ lastError: code as ConversationError });
      }
    },

    loadHistory: async () => {
      try {
        set({ history: await fetchConversations() });
      } catch { /* the list keeps what it had; the sheet shows its empty state */ }
    },

    viewConversation: async (id) => {
      // A refusal (rating_closed, say) belongs to the conversation it came from, not the next one shown.
      if (id === null || id === get().conversation?.id) {
        set({ viewing: null, historyMessages: [], lastError: null });
        if (isSeen()) seenNow();
        return;
      }
      set({ viewing: id, historyMessages: [], lastError: null });
      try {
        const messages = await fetchConversationMessages(id);
        if (get().viewing === id) set({ historyMessages: messages });
      } catch { /* stays empty; the sheet can be reopened */ }
    },

    toggleMute: () => {
      const muted = !get().muted;
      setMuted(muted);
      set({ muted });
    },

    clearError: () => set({ lastError: null }),

    __reset: () => {
      disconnect();
      clearAttention();
      set({ ...initial(), muted: isMuted() });
    },
  };
});
