import { useEffect, useRef, useState } from "react";
import { ChevronLeft, History, MoreVertical, Star, Volume2, VolumeX, X } from "lucide-react";
import { useSupportChat } from "@/lib/support-chat/store";
import { useLocale, useT } from "@/lib/i18n";
import { Thread } from "./Thread";
import { Composer } from "./Composer";
import { RatingCard } from "./RatingCard";
import { PersonaAvatar, PresenceDot } from "./PersonaAvatar";

const iconBtn = "flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]";
const outlineBtn = "rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-secondary)]";

/** The seven days the server allows for rating an ended conversation. */
const RATING_WINDOW_SEC = 7 * 24 * 3600;

/**
 * Live chat inside Profile > Help & contact: header, banners, the thread or a
 * past conversation, the rating card or composer, and the conversations list.
 * Mounting it counts as "on screen" for seen and unread (store.showChat).
 */
export function ChatView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const conn = useSupportChat((s) => s.conn);
  const persona = useSupportChat((s) => s.persona);
  const conversation = useSupportChat((s) => s.conversation);
  const viewing = useSupportChat((s) => s.viewing);
  const historyMessages = useSupportChat((s) => s.historyMessages);
  const history = useSupportChat((s) => s.history);
  const muted = useSupportChat((s) => s.muted);
  const lastError = useSupportChat((s) => s.lastError);
  // The room refuses to end a conversation nobody wrote in (system lines do not count).
  const somethingSaid = useSupportChat((s) => s.messages.some((m) => m.author_type !== "system"));
  const showChat = useSupportChat((s) => s.showChat);
  const endConversation = useSupportChat((s) => s.endConversation);
  const startConversation = useSupportChat((s) => s.startConversation);
  const rate = useSupportChat((s) => s.rate);
  const toggleMute = useSupportChat((s) => s.toggleMute);
  const viewConversation = useSupportChat((s) => s.viewConversation);
  const clearError = useSupportChat((s) => s.clearError);

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    showChat(true);
    return () => showChat(false);
  }, [showChat]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const pastView = viewing !== null && viewing !== conversation?.id;
  const pastItem = pastView ? history.find((h) => h.id === viewing) ?? null : null;
  const ended = conversation?.status === "ended";
  const canEnd = !ended && !!conversation && somethingSaid;

  let status: string;
  if (ended) status = t("support-chat.label.conversationEnded");
  // Support always reads as available (a product decision): never "Away", whoever is at a desk.
  else if (persona) status = t("support-chat.status.personaIsOnline", { name: persona.name });
  else status = t("support-chat.status.onlineUsuallyRepliesInAFewMinutes");
  const heading = persona ? t("support-chat.heading.personaFromDosya", { name: persona.name }) : t("support-chat.heading.dosyaSupport");

  const startButton = (
    <button type="button" className={outlineBtn} style={{ borderColor: "var(--color-border)" }} onClick={() => { clearError(); startConversation(); }}>
      {t("support-chat.action.startANewConversation")}
    </button>
  );
  const ratingClosed = (c: { ended_at: number | null } | null) =>
    lastError === "rating_closed" || (c?.ended_at != null && Date.now() / 1000 - c.ended_at > RATING_WINDOW_SEC);

  let body;
  if (pastView) {
    body = (
      <>
        <Thread messages={historyMessages} />
        <div className="flex flex-col gap-2 border-t p-3" style={{ borderColor: "var(--color-border)" }}>
          {pastItem && pastItem.status === "ended" && (
            <RatingCard name={pastItem.persona?.name ?? null} rating={pastItem.rating} closed={ratingClosed(pastItem)} onRate={rate} />
          )}
          <div className="flex justify-between gap-2">
            <button type="button" className={outlineBtn} style={{ borderColor: "var(--color-border)" }} onClick={() => void viewConversation(null)}>
              {t("support-chat.action.back")}
            </button>
            {startButton}
          </div>
        </div>
      </>
    );
  } else if (ended) {
    body = (
      <>
        <Thread />
        <div className="flex flex-col gap-2 border-t p-3" style={{ borderColor: "var(--color-border)" }}>
          <RatingCard name={persona?.name ?? null} rating={conversation?.rating ?? null} closed={ratingClosed(conversation)} onRate={rate} />
          {lastError === "too_many_conversations" && (
            <p role="alert" className="text-xs text-[var(--color-text-muted)]">{t("support-chat.description.youHaveStartedTooManyConversationsToday")}</p>
          )}
          {startButton}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Thread />
        <Composer />
      </>
    );
  }

  return (
    <div className="flex h-full max-w-2xl flex-col" data-testid="support-chat-view">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 flex items-center gap-1 self-start text-sm text-[var(--color-primary)] hover:underline"
      >
        <ChevronLeft size={16} className="rtl:-scale-x-100" /> {t("profile.heading.helpContact")}
      </button>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border" style={{ borderColor: "var(--color-border)" }}>
        <header className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <PersonaAvatar persona={persona} size={32} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{heading}</h2>
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
              {!ended && <PresenceDot online />}
              <span className="truncate">{status}</span>
            </p>
          </div>
          <button
            type="button"
            className={iconBtn}
            aria-pressed={muted}
            aria-label={muted ? t("support-chat.action.unmuteSounds") : t("support-chat.action.muteSounds")}
            title={muted ? t("support-chat.action.unmuteSounds") : t("support-chat.action.muteSounds")}
            onClick={toggleMute}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button type="button" className={iconBtn} aria-label={t("support-chat.action.conversations")} title={t("support-chat.action.conversations")} onClick={() => setListOpen(true)}>
            <History size={16} />
          </button>
          {canEnd && (
            <div ref={menuRef} className="relative" onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }}>
              <button
                type="button"
                className={iconBtn}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t("support-chat.action.moreOptions")}
                title={t("support-chat.action.moreOptions")}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <MoreVertical size={16} />
              </button>
              {menuOpen && (
                <div role="menu" className="absolute end-0 top-9 z-20 min-w-44 rounded-lg border bg-[var(--color-bg)] p-1 text-sm shadow-md" style={{ borderColor: "var(--color-border)" }}>
                  <button
                    type="button"
                    role="menuitem"
                    autoFocus
                    className="block w-full rounded px-2 py-1.5 text-start hover:bg-[var(--color-bg-secondary)]"
                    onClick={() => { setMenuOpen(false); setConfirmEnd(true); }}
                  >
                    {t("support-chat.action.endConversation")}
                  </button>
                </div>
              )}
            </div>
          )}
        </header>
        {confirmEnd && (
          <div role="alertdialog" aria-label={t("support-chat.action.endConversation")} className="flex items-center gap-2 border-b bg-[var(--color-bg-secondary)] px-4 py-2 text-xs" style={{ borderColor: "var(--color-border)" }}>
            <p className="flex-1">{t("support-chat.description.endThisConversation")}</p>
            <button type="button" autoFocus className="rounded-lg bg-[var(--color-danger)] px-3 py-1 font-medium text-white hover:bg-[var(--color-danger-hover)]" onClick={() => { setConfirmEnd(false); endConversation(); }}>
              {t("common.yes")}
            </button>
            <button type="button" className={outlineBtn} style={{ borderColor: "var(--color-border)" }} onClick={() => setConfirmEnd(false)}>{t("common.no")}</button>
          </div>
        )}
        {(conn === "reconnecting" || conn === "polling") && (
          <div role="status" className="bg-[var(--color-bg-secondary)] px-4 py-1 text-center text-xs text-[var(--color-text-muted)]">{t("support-chat.status.reconnecting")}</div>
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {body}
          {listOpen && <ConversationList onClose={() => setListOpen(false)} />}
        </div>
      </div>
    </div>
  );
}

/** Slides over the chat body: past and current conversations, newest first. */
function ConversationList({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const history = useSupportChat((s) => s.history);
  const loadHistory = useSupportChat((s) => s.loadHistory);
  const viewConversation = useSupportChat((s) => s.viewConversation);
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  return (
    <div
      role="region"
      aria-label={t("support-chat.action.conversations")}
      className="absolute inset-0 z-10 flex flex-col bg-[var(--color-bg)]"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
    >
      <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="text-sm font-semibold">{t("support-chat.action.conversations")}</h3>
        <button type="button" autoFocus className={iconBtn} aria-label={t("support-chat.action.close")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {history.length === 0 ? (
        <p className="p-4 text-center text-sm text-[var(--color-text-muted)]">{t("support-chat.label.noConversationsYet")}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {history.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 border-b px-4 py-2.5 text-start hover:bg-[var(--color-bg-secondary)]"
                style={{ borderColor: "var(--color-border)" }}
                onClick={() => { void viewConversation(c.id); onClose(); }}
              >
                <PersonaAvatar persona={c.persona} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" dir="auto">{c.title || t("support-chat.label.conversation")}</span>
                  <span className="block truncate text-xs text-[var(--color-text-muted)]">
                    {c.persona ? `${c.persona.name} · ` : ""}{fmt.format(new Date(c.started_at * 1000))}
                  </span>
                </span>
                {c.rating && (
                  <span className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--color-text-muted)]" aria-label={t("support-chat.label.starsOutOfFive", { count: c.rating.stars })}>
                    <Star size={14} aria-hidden="true" className="fill-amber-400 text-amber-400" />
                    <span aria-hidden="true">{c.rating.stars}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
