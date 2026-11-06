import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/files/Modal";
import { useT } from "@/lib/i18n";
import { nameError } from "@/lib/policy-error";
import { baseNameEnd, defaultFileName, withExtension, type NewFileKind } from "@/lib/blank-files";
import type { MessageKey } from "../../../i18n/keys";

const HEADINGS: Record<NewFileKind, MessageKey> = {
  markdown: "files.heading.newMarkdownFile",
  text: "files.heading.newTextFile",
  word: "files.heading.newWordDocument",
};

/**
 * Names a new blank file. Looks like the New folder dialog; the name starts
 * as "Untitled.md" with only "Untitled" selected, and the kind's extension is
 * put back if the user drops or changes it.
 *
 * `onCreate` gets the final name and answers with an error to show under the
 * field (the dialog stays open), or null once the file exists - the caller
 * closes the dialog then.
 */
export function NewFileDialog({
  kind,
  onCancel,
  onCreate,
}: {
  kind: NewFileKind;
  onCancel: () => void;
  onCreate: (name: string) => Promise<string | null>;
}) {
  const t = useT();
  const [name, setName] = useState(() => defaultFileName(kind, t("files.label.untitled")));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, baseNameEnd(input.value, kind));
    // Once, on open: later edits keep the caret where the user put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (busy) return;
    const finalName = withExtension(name, kind);
    const problem = nameError(finalName, "file");
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const refused = await onCreate(finalName);
      if (refused) setError(refused);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={() => { if (!busy) onCancel(); }}>
      <h3 className="mb-4 text-lg font-semibold">{t(HEADINGS[kind])}</h3>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void submit(); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busy) onCancel(); }
        }}
        aria-label={t("common.label.name")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "new-file-error" : undefined}
        readOnly={busy}
        className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)] focus:ring-1 focus:ring-[var(--color-primary)] ${error ? "mb-2" : "mb-4"}`}
        style={{ borderColor: error ? "var(--color-danger)" : "var(--color-border)" }}
      />
      {error && (
        <p id="new-file-error" role="alert" className="mb-4 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50"
          style={{ borderColor: "var(--color-border)" }}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:opacity-50"
          style={{ background: "var(--color-primary)" }}
        >
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common.action.create")}
        </button>
      </div>
    </Modal>
  );
}
