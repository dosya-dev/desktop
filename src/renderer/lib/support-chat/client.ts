// Hand copy of apps/web/src/lib/support-chat/client.ts; keep in step. Only restErrorCode differs (desktop ApiError carries data, not body).
import type { ChatDiagnostics, ChatMessage, ClientFrame, Conversation, LiveMessage, Persona, Rating, ServerFrame } from './types';
import { CHAT_CLOSE_NOT_AVAILABLE } from './types';

// Framework-free live chat connection. Owns reconnect, the offline queue and
// the REST polling fallback; knows nothing about React or the DOM beyond the
// injected WebSocket and timers.

export type ConnState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'polling' | 'closed';
export type ClientEvent = { type: 'state'; state: ConnState } | { type: 'frame'; frame: ServerFrame };
export type ChatErrorCode = Extract<ServerFrame, { type: 'error' }>['code'];

const ERROR_CODES: ReadonlySet<string> = new Set<ChatErrorCode>([
  'bad_frame', 'too_long', 'rate_limited', 'not_available', 'too_many_attachments',
  'conversation_ended', 'rating_closed', 'not_ended', 'too_many_conversations', 'persona_required', 'conversation_empty',
]);

/** The chat error code in a failed REST call (`{ ok: false, error }` parsed into ApiError.data), or null. */
export function restErrorCode(err: unknown): ChatErrorCode | null {
  const code = (err as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === 'string' && ERROR_CODES.has(code) ? (code as ChatErrorCode) : null;
}

interface RestDeps {
  fetchMessages(after?: number): Promise<ChatMessage[]>;
  postMessage(i: { id: string; body: string; attachment_ids?: string[] }): Promise<ChatMessage>;
  postSeen(): Promise<void>;
  endConversation(): Promise<Conversation>;
  startConversation(): Promise<Conversation>;
  postRating(i: { stars: number; solved: boolean; comment?: string }): Promise<Rating>;
}

export interface SupportChatClientDeps {
  socketUrl: () => string;
  WebSocket?: typeof WebSocket;
  rest: RestDeps;
  onEvent: (e: ClientEvent) => void;
  /** Diagnostics for the hello frame, built by the caller (the DOM lives there). */
  diagnostics?: () => ChatDiagnostics | undefined;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const STABLE_MS = 10_000;
const FAIL_WINDOW_MS = 30_000;
const FAIL_LIMIT = 3;
const POLL_MS = 10_000;
const POLL_SOCKET_RETRY_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

export function newMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}

export class SupportChatClient {
  private state: ConnState = 'idle';
  private ws: InstanceType<typeof WebSocket> | null = null;
  private queue: ClientFrame[] = [];
  /** Messages sent on the socket but not yet acked; re-queued with the same id if the socket drops. */
  private inflight = new Map<string, ClientFrame>();
  private failures: number[] = [];
  private backoffIdx = 0;
  private openedAt = 0;
  private reconnectTimer: Timer | null = null;
  private pollTimer: Timer | null = null;
  private socketRetryTimer: Timer | null = null;
  private lastCreatedAt = 0;
  private seen = new Set<string>();
  /** The active conversation as last announced; polling uses it for personas and REST rate results. */
  private conversation: Conversation | null = null;
  private wanted = false;
  private readonly now: () => number;
  private readonly setT: typeof setTimeout;
  private readonly clearT: typeof clearTimeout;

  constructor(private readonly deps: SupportChatClientDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setT = deps.setTimer ?? (((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout);
    this.clearT = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  connect(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.setState('connecting');
    this.openSocket();
  }

  close(): void {
    this.wanted = false;
    this.clearTimers();
    this.detach();
    this.queue = [];
    this.inflight.clear();
    this.setState('idle');
  }

  send(frame: ClientFrame): void {
    if (this.state === 'online') {
      if (frame.type === 'message') this.inflight.set(frame.id, frame);
      this.ws?.send(JSON.stringify(frame));
      return;
    }
    if (this.state === 'polling') {
      this.sendOverRest(frame);
      return;
    }
    if (this.state === 'closed') return;
    // Typing is only meaningful live; everything else waits for the socket.
    if (frame.type === 'typing') return;
    this.queue.push(frame);
  }

  sendMessage(body: string, attachmentIds?: string[], id: string = newMessageId()): string {
    const frame: ClientFrame = { v: 1, type: 'message', id, body };
    if (attachmentIds && attachmentIds.length) frame.attachment_ids = attachmentIds;
    this.send(frame);
    return id;
  }

  /** Drop a not-yet-flushed message (the caller gave up on it). */
  discard(id: string): void {
    this.queue = this.queue.filter((f) => !(f.type === 'message' && f.id === id));
    this.inflight.delete(id);
  }

  // --- socket -------------------------------------------------------------

  private openSocket(): void {
    const Ctor = this.deps.WebSocket ?? globalThis.WebSocket;
    let ws: InstanceType<typeof WebSocket>;
    try {
      ws = new Ctor(this.deps.socketUrl());
    } catch {
      this.goPolling();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openedAt = this.now();
      this.failures = [];
      this.stopPolling();
      this.setState('online');
      ws.send(JSON.stringify({ v: 1, type: 'hello', diagnostics: this.deps.diagnostics?.() } satisfies ClientFrame));
      const queued = this.queue;
      this.queue = [];
      for (const f of queued) {
        if (f.type === 'message') this.inflight.set(f.id, f);
        ws.send(JSON.stringify(f));
      }
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return;
      let frame: ServerFrame;
      try { frame = JSON.parse(String(e.data)) as ServerFrame; } catch { return; }
      this.track(frame);
      this.deps.onEvent({ type: 'frame', frame });
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onSocketClosed(e.code, e.reason);
    };
  }

  private onSocketClosed(code: number, reason: string): void {
    if (!this.wanted) return;
    this.requeueInflight();
    if (code === CHAT_CLOSE_NOT_AVAILABLE) {
      this.stop('error', 'not_available', reason || 'not_available');
      return;
    }
    if (code >= 4000 && code <= 4099) {
      this.stop('error', 'bad_frame', reason || 'closed');
      return;
    }
    const wasPolling = this.state === 'polling';
    const stable = this.openedAt > 0 && this.now() - this.openedAt >= STABLE_MS;
    if (stable) this.backoffIdx = 0;
    this.openedAt = 0;
    if (wasPolling) return; // a failed retry; the 60 s retry timer is already armed
    const t = this.now();
    this.failures = this.failures.filter((x) => t - x <= FAIL_WINDOW_MS);
    this.failures.push(t);
    if (this.failures.length >= FAIL_LIMIT) {
      this.goPolling();
      return;
    }
    this.setState('reconnecting');
    const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
    this.backoffIdx++;
    this.reconnectTimer = this.setT(() => {
      this.reconnectTimer = null;
      if (this.wanted) this.openSocket();
    }, delay);
  }

  private requeueInflight(): void {
    if (this.inflight.size === 0) return;
    this.queue = [...this.inflight.values(), ...this.queue];
    this.inflight.clear();
  }

  private stop(type: 'error', code: 'not_available' | 'bad_frame', message: string): void {
    this.wanted = false;
    this.clearTimers();
    this.queue = [];
    this.setState('closed');
    this.deps.onEvent({ type: 'frame', frame: { v: 1, type, code, message } });
  }

  private detach(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }

  // --- polling ------------------------------------------------------------

  private goPolling(): void {
    if (this.state === 'polling') return; // already polling: keep the existing timer chains
    this.detach();
    if (this.reconnectTimer) { this.clearT(this.reconnectTimer); this.reconnectTimer = null; }
    this.failures = [];
    this.setState('polling');
    const queued = this.queue;
    this.queue = [];
    for (const f of queued) this.sendOverRest(f);
    this.schedulePoll();
    this.scheduleSocketRetry();
  }

  private stopPolling(): void {
    if (this.pollTimer) { this.clearT(this.pollTimer); this.pollTimer = null; }
    if (this.socketRetryTimer) { this.clearT(this.socketRetryTimer); this.socketRetryTimer = null; }
  }

  private schedulePoll(): void {
    if (this.pollTimer) this.clearT(this.pollTimer);
    this.pollTimer = this.setT(() => {
      this.pollTimer = null;
      void this.poll().finally(() => { if (this.wanted && this.state === 'polling') this.schedulePoll(); });
    }, POLL_MS);
  }

  private async poll(): Promise<void> {
    try {
      const messages = await this.deps.rest.fetchMessages(this.lastCreatedAt ? Math.max(0, this.lastCreatedAt - 1) : undefined);
      if (!this.wanted || this.state !== 'polling') return;
      for (const m of messages) {
        if (this.seen.has(m.id)) continue;
        this.seen.add(m.id);
        this.lastCreatedAt = Math.max(this.lastCreatedAt, m.created_at);
        if (m.author_type !== 'user') this.deps.onEvent({ type: 'frame', frame: { v: 1, type: 'message', message: this.live(m) } });
      }
    } catch { /* next tick tries again */ }
  }

  private scheduleSocketRetry(): void {
    if (this.socketRetryTimer) this.clearT(this.socketRetryTimer);
    this.socketRetryTimer = this.setT(() => {
      this.socketRetryTimer = null;
      if (!this.wanted || this.state !== 'polling') return;
      this.openSocket();
      this.scheduleSocketRetry();
    }, POLL_SOCKET_RETRY_MS);
  }

  private sendOverRest(frame: ClientFrame): void {
    const { rest } = this.deps;
    if (frame.type === 'message') {
      const { id, body, attachment_ids } = frame;
      const input = attachment_ids ? { id, body, attachment_ids } : { id, body };
      rest.postMessage(input).then(
        (stored) => {
          const message = this.live(stored);
          this.track({ v: 1, type: 'ack', id, message });
          this.emit({ v: 1, type: 'ack', id, message });
        },
        (err) => this.emit({ v: 1, type: 'error', code: restErrorCode(err) ?? 'bad_frame', message: 'send_failed' }),
      );
    } else if (frame.type === 'seen') {
      rest.postSeen().catch(() => undefined);
    } else if (frame.type === 'end' || frame.type === 'start') {
      const call = frame.type === 'end' ? rest.endConversation() : rest.startConversation();
      call.then((conversation) => this.emitConversation(conversation), (err) => this.emitRestError(err));
    } else if (frame.type === 'rate') {
      const { stars, solved, comment } = frame;
      rest.postRating(comment !== undefined ? { stars, solved, comment } : { stars, solved }).then(
        (rating) => { if (this.conversation) this.emitConversation({ ...this.conversation, rating }); },
        (err) => this.emitRestError(err),
      );
    }
    // hello, delivered and typing have no REST equivalent.
  }

  /** A synthetic conversation frame, as the room would have broadcast it. */
  private emitConversation(conversation: Conversation): void {
    const frame: ServerFrame = { v: 1, type: 'conversation', conversation };
    this.track(frame);
    this.emit(frame);
  }

  private emitRestError(err: unknown): void {
    const code = restErrorCode(err) ?? 'bad_frame';
    this.emit({ v: 1, type: 'error', code, message: code });
  }

  private emit(frame: ServerFrame): void {
    if (this.wanted) this.deps.onEvent({ type: 'frame', frame });
  }

  /** A REST row as a live message: the persona is known when it is the conversation's own. */
  private live(m: ChatMessage): LiveMessage {
    const p: Persona | null = this.conversation?.persona ?? null;
    return { ...m, persona: p && m.persona_id === p.id ? p : null };
  }

  // --- bookkeeping --------------------------------------------------------

  private track(frame: ServerFrame): void {
    const bump = (m: ChatMessage) => { this.seen.add(m.id); this.lastCreatedAt = Math.max(this.lastCreatedAt, m.created_at); };
    if (frame.type === 'ready') { frame.messages.forEach(bump); this.conversation = frame.conversation; }
    else if (frame.type === 'conversation') this.conversation = frame.conversation;
    else if (frame.type === 'message') bump(frame.message);
    else if (frame.type === 'ack') { bump(frame.message); this.inflight.delete(frame.id); }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) { this.clearT(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopPolling();
  }

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onEvent({ type: 'state', state });
  }
}
