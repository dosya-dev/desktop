import { useEffect, useRef } from "react";
import { chatAttachmentUrl } from "@/lib/support-chat/api";
import { useSupportChat, type ThreadMessage } from "@/lib/support-chat/store";
import type { ChatMessage } from "@/lib/support-chat/types";
import { useLocale, useT } from "@/lib/i18n";
import { PersonaAvatar } from "./PersonaAvatar";

function dayKey(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * The scrolling message list: day separators, bubbles, system lines, typing dots.
 * `messages` overrides the live store (a past conversation, read-only).
 */
export function Thread({ messages: fixed }: { messages?: ThreadMessage[] }) {
  const t = useT();
  const { locale } = useLocale();
  const live = useSupportChat((s) => s.messages);
  const messages = fixed ?? live;
  const typing = useSupportChat((s) => s.typing);
  const typingName = useSupportChat((s) => s.typingName);
  const pending = useSupportChat((s) => s.pending);
  const staffSeenAt = useSupportChat((s) => s.staffSeenAt);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing]);

  const todayKey = dayKey(Math.floor(Date.now() / 1000));
  const dayLabel = (sec: number) => (dayKey(sec) === todayKey
    ? t("support-chat.label.today")
    : new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(sec * 1000)));
  const lastOwn = [...messages].reverse().find((m) => m.author_type === "user");

  const ownStatus = (m: ChatMessage): string => {
    if (pending[m.id] === "uploading" || pending[m.id] === "sending") return t("support-chat.status.sending");
    if (m.created_at <= staffSeenAt) return t("support-chat.status.seen");
    return t("support-chat.status.sent");
  };

  return (
    <div ref={ref} role="log" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4" data-testid="support-chat-thread">
      {messages.map((m, i) => {
        const showDay = i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at);
        return (
          <div key={m.id} className="flex flex-col gap-2">
            {showDay && (
              <div className="self-center py-1 text-xs text-[var(--color-text-muted)]">{dayLabel(m.created_at)}</div>
            )}
            {m.author_type === "system" ? (
              <SystemLine message={m} />
            ) : (
              <Bubble message={m} status={m.id === lastOwn?.id ? ownStatus(m) : null} />
            )}
          </div>
        );
      })}
      {typing && (
        <div className="flex items-center gap-2 self-start" role="status">
          <div className="flex gap-1 rounded-2xl border px-3 py-2.5" style={{ borderColor: "var(--color-border)" }} aria-hidden="true">
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                className="size-1.5 animate-bounce rounded-full bg-[var(--color-text-muted)] motion-reduce:animate-none"
                style={{ animationDelay: `${d}ms` }}
              />
            ))}
          </div>
          <span className="text-xs text-[var(--color-text-muted)]">
            {t("support-chat.status.personaIsTyping", { name: typingName || t("support-chat.heading.dosyaSupport") })}
          </span>
        </div>
      )}
    </div>
  );
}

function Bubble({ message: m, status }: { message: ThreadMessage; status: string | null }) {
  const own = m.author_type === "user";
  return (
    <div className={`flex max-w-[80%] gap-2 ${own ? "self-end" : "self-start"}`}>
      {!own && <PersonaAvatar persona={m.persona ?? null} size={24} />}
      <div className={`flex min-w-0 flex-col gap-0.5 ${own ? "items-end" : "items-start"}`}>
        <div
          className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
            own ? "bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "border bg-[var(--color-bg-secondary)]"
          }`}
          style={own ? undefined : { borderColor: "var(--color-border)" }}
          dir="auto"
        >
          {m.body}
          {m.previews ? m.previews.map((p) => (
            // The sender's own images, shown from memory from the moment Send was pressed.
            p.url ? (
              <img key={p.key} src={p.url} alt={p.name} className="mt-1.5 block max-h-48 rounded-lg" />
            ) : (
              <span key={p.key} className="mt-1.5 block text-xs opacity-80">{p.name}</span>
            )
          )) : m.attachments.map((a) => (
            <img
              key={a.id}
              src={chatAttachmentUrl(a.id)}
              alt={a.file_name}
              loading="lazy"
              crossOrigin="use-credentials"
              className="mt-1.5 block max-h-48 rounded-lg"
            />
          ))}
        </div>
        {status && <span className="px-1 text-xs text-[var(--color-text-muted)]">{status}</span>}
      </div>
    </div>
  );
}

function SystemLine({ message: m }: { message: ChatMessage }) {
  const t = useT();
  let text = m.body;
  if (m.kind === "ticket_created") {
    text = t("support-chat.description.weOpenedTicketTicketnumberForThis", { ticketNumber: String(m.meta?.ticket_number ?? "") });
  } else if (m.kind === "persona_joined") {
    const who = m.meta?.persona_name;
    if (typeof who === "string" && who) text = t("support-chat.description.personaJoinedTheConversation", { name: who });
  } else if (m.kind === "closed") {
    // Whoever ended it, the conversation is over; the body is the admin's English.
    text = t("support-chat.label.conversationEnded");
  }
  return <div className="self-center text-center text-xs text-[var(--color-text-muted)]">{text}</div>;
}
