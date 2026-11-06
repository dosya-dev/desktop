import { useEffect, useRef } from "react";
import { Modal } from "@/components/files/Modal";

export interface ConfirmAction {
  label: string;
  onClick: () => void;
  tone?: "primary" | "danger" | "secondary";
  /** Receives focus when the dialog opens. */
  autoFocus?: boolean;
  disabled?: boolean;
}

const TONE: Record<NonNullable<ConfirmAction["tone"]>, string> = {
  primary: "bg-[var(--color-primary)] font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus:ring-2 focus:ring-[var(--color-primary)]/40",
  danger: "bg-[var(--color-danger)] font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-danger-hover)] focus:ring-2 focus:ring-[var(--color-danger)]/40",
  secondary: "border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)]",
};

/**
 * The product's confirmation shape: a fixed question as the title ("Are you
 * sure?") and one sentence saying what is at stake, then the choices. Escape
 * is the cancel path. Rendered outside the editor's key-trapping root, so its
 * window-level Escape listener always hears the key.
 */
export function ConfirmDialog({
  id,
  title,
  description,
  detail,
  actions,
  onCancel,
}: {
  id: string;
  title: string;
  description: string;
  detail?: string | null;
  actions: ConfirmAction[];
  onCancel: () => void;
}) {
  const focusRef = useRef<HTMLButtonElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;

  useEffect(() => {
    focusRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancel.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Modal onClose={onCancel}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} data-testid={id}>
        <h3 id={`${id}-title`} className="text-lg font-semibold text-[var(--color-text)]">{title}</h3>
        <p id={`${id}-description`} className="mt-1 text-sm text-[var(--color-text-secondary)]">{description}</p>
        {detail && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{detail}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {actions.map((a) => (
            <button
              key={a.label}
              ref={a.autoFocus ? focusRef : undefined}
              type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              className={`rounded-lg px-4 py-2 text-sm focus:outline-none disabled:opacity-50 ${TONE[a.tone ?? "secondary"]}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
