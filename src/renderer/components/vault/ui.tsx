import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";

/**
 * The few controls the Vault screens share, on the renderer's tokens. Kept
 * here rather than in a general kit because the rest of the app writes its
 * classes inline; this is the one feature with five screens of forms.
 */
type Variant = "primary" | "outline" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary: "bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]",
  outline: "border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]",
  danger: "bg-[var(--color-danger)] text-white hover:bg-[var(--color-danger-hover)]",
  ghost: "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]",
};

export function VaultButton({
  variant = "primary", size = "md", className = "", ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "icon" }) {
  const sizing = size === "sm" ? "h-8 px-3 text-xs" : size === "icon" ? "h-7 w-7 justify-center" : "h-9 px-4 text-sm";
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${VARIANT[variant]} ${className}`}
    />
  );
}

export function VaultInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)] disabled:opacity-60 ${className}`}
    />
  );
}

export function VaultLabel(props: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label {...props} className="mb-1.5 block text-xs font-medium text-[var(--color-text)]" />;
}

export function VaultCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 ${className}`}>
      {children}
    </div>
  );
}

/** A framed sentence: warn (amber), danger (red) or muted (neutral). */
export function Notice({ tone, icon, children }: { tone: "warn" | "danger" | "muted"; icon?: ReactNode; children: ReactNode }) {
  const tones = {
    warn: "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-text)]",
    danger: "border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 text-[var(--color-danger)]",
    muted: "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]",
  }[tone];
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tones}`}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="flex-1">{children}</div>
    </div>
  );
}
