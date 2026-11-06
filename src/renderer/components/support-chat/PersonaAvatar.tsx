import { Logo } from "@/components/Logo";
import { personaAvatarUrl } from "@/lib/support-chat/api";
import type { Persona } from "@/lib/support-chat/types";

/** Presence dot: green when staff are online, grey otherwise. */
export function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: online ? "var(--brand)" : "var(--color-text-muted)" }}
    />
  );
}

/**
 * Who is answering: the persona's photo when there is one, otherwise the dosya
 * mark (no persona, or a persona without a picture). Decorative: the name sits beside it.
 */
export function PersonaAvatar({ persona, size = 28 }: { persona: Pick<Persona, "name" | "avatar_url"> | null; size?: number }) {
  const style = { width: size, height: size };
  if (persona?.avatar_url) {
    return (
      <img
        src={personaAvatarUrl(persona.avatar_url)}
        alt=""
        aria-hidden="true"
        crossOrigin="use-credentials"
        style={style}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="support-logo-avatar"
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full border bg-[var(--color-bg)] text-[var(--color-text)]"
    >
      <Logo style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62) }} />
    </span>
  );
}
