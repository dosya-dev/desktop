import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { Rating } from "@/lib/support-chat/types";

const MAX_COMMENT = 500;

/**
 * Stars, "was it solved" and an optional note, shown once a conversation ended.
 * A saved rating stays editable until the 7-day rating window closes; then the
 * card is read-only. Port of the web rating card.
 */
export function RatingCard({ name, rating, closed, onRate }: {
  name: string | null;
  rating: Rating | null;
  closed: boolean;
  onRate: (stars: number, solved: boolean, comment: string) => Promise<void>;
}) {
  const t = useT();
  const [stars, setStars] = useState(rating?.stars ?? 0);
  const [solved, setSolved] = useState<boolean | null>(rating?.solved ?? null);
  const [comment, setComment] = useState(rating?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  // A saved rating (this one just submitted, or one from another device) becomes the new starting point.
  useEffect(() => {
    if (!rating) return;
    setStars(rating.stars);
    setSolved(rating.solved);
    setComment(rating.comment ?? "");
  }, [rating?.stars, rating?.solved, rating?.comment]); // eslint-disable-line react-hooks/exhaustive-deps

  const heading = name ? t("support-chat.heading.howWasYourChatWithName", { name }) : t("support-chat.heading.howWasYourChat");
  const shownStars = rating ? rating.stars : stars;
  const unchanged = rating !== null && stars === rating.stars && solved === rating.solved && comment.trim() === (rating.comment ?? "");
  const starLabel = (n: number) => t("support-chat.label.starsOutOfFive", { count: n });
  const starClass = (on: boolean) => (on ? "fill-amber-400 text-amber-400" : "text-[var(--color-text-muted)]");

  const move = (to: number) => {
    const next = Math.min(5, Math.max(1, to));
    setStars(next);
    refs.current[next - 1]?.focus();
  };
  const onKey = (e: React.KeyboardEvent, n: number) => {
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    if (e.key === "ArrowRight") { e.preventDefault(); move(n + (rtl ? -1 : 1)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(n + (rtl ? 1 : -1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(n + 1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(n - 1); }
  };
  const submit = async () => {
    if (!stars || solved === null || busy || unchanged) return;
    setBusy(true);
    try { await onRate(stars, solved, comment); } finally { setBusy(false); }
  };
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs ${active ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "hover:bg-[var(--color-bg-secondary)]"}`;

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border p-3 text-sm" style={{ borderColor: "var(--color-border)" }}>
      <p className="font-medium">{heading}</p>
      {closed ? (
        <div className="flex items-center gap-0.5" role="img" aria-label={starLabel(shownStars)}>
          {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={20} aria-hidden="true" className={starClass(n <= shownStars)} />)}
        </div>
      ) : (
        <div role="radiogroup" aria-label={heading} className="flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              ref={(el) => { refs.current[n - 1] = el; }}
              type="button"
              role="radio"
              aria-checked={stars === n}
              aria-label={starLabel(n)}
              tabIndex={stars === n || (stars === 0 && n === 1) ? 0 : -1}
              className="rounded p-0.5"
              onClick={() => setStars(n)}
              onKeyDown={(e) => onKey(e, n)}
            >
              <Star size={20} aria-hidden="true" className={starClass(n <= stars)} />
            </button>
          ))}
        </div>
      )}
      {closed ? (
        <>
          {rating && <p className="text-xs text-[var(--color-text-muted)]">{rating.solved ? t("support-chat.label.solved") : t("support-chat.label.notSolved")}</p>}
          {rating?.comment && <p className="whitespace-pre-wrap break-words text-xs" dir="auto">{rating.comment}</p>}
          {rating && <p className="text-xs text-[var(--color-text-muted)]">{t("support-chat.feedback.thanksForYourFeedback")}</p>}
        </>
      ) : (
        <>
          {rating && <p className="text-xs text-[var(--color-text-muted)]">{t("support-chat.feedback.thanksForYourFeedback")}</p>}
          <p className="text-xs text-[var(--color-text-muted)]">{t("support-chat.label.wasYourIssueSolved")}</p>
          <div className="flex gap-2">
            <button type="button" aria-pressed={solved === true} className={pill(solved === true)} onClick={() => setSolved(true)}>{t("common.yes")}</button>
            <button type="button" aria-pressed={solved === false} className={pill(solved === false)} onClick={() => setSolved(false)}>{t("common.no")}</button>
          </div>
          <textarea
            value={comment}
            maxLength={MAX_COMMENT}
            rows={2}
            placeholder={t("support-chat.placeholder.anythingElseOptional")}
            aria-label={t("support-chat.placeholder.anythingElseOptional")}
            className="min-h-12 resize-none rounded-lg border bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
            style={{ borderColor: "var(--color-border)" }}
            onChange={(e) => setComment(e.target.value)}
          />
          <button
            type="button"
            className="self-end rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            disabled={!stars || solved === null || busy || unchanged}
            onClick={() => void submit()}
          >
            {t("support-chat.action.sendRating")}
          </button>
        </>
      )}
    </div>
  );
}
