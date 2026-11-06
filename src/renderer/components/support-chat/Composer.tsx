import { useEffect, useRef, useState } from "react";
import { ImagePlus, Send, X } from "lucide-react";
import { useSupportChat } from "@/lib/support-chat/store";
import { useT } from "@/lib/i18n";

const MAX_IMAGES = 10;
const TYPING_IDLE_MS = 3000;
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Textarea + Screenshot + Send; replaced by a plain line for free plans. */
export function Composer() {
  const t = useT();
  const conn = useSupportChat((s) => s.conn);
  const notAvailable = useSupportChat((s) => s.notAvailable);
  const lastFailedDraft = useSupportChat((s) => s.lastFailedDraft);
  const send = useSupportChat((s) => s.send);
  const setTyping = useSupportChat((s) => s.setTyping);
  const clearFailedDraft = useSupportChat((s) => s.clearFailedDraft);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // A message that failed to send comes back as editable text.
  useEffect(() => {
    if (lastFailedDraft == null) return;
    setText(lastFailedDraft);
    clearFailedDraft();
  }, [lastFailedDraft, clearFailedDraft]);

  useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current); }, []);

  if (notAvailable) {
    return (
      <p className="border-t p-3 text-sm text-[var(--color-text-muted)]" style={{ borderColor: "var(--color-border)" }}>
        {t("support-chat.description.liveChatIsAvailableOnPaidPlans")}
      </p>
    );
  }

  const disabled = conn === "closed";
  const addFiles = (more: File[]) => setFiles((cur) => [...cur, ...more.filter((f) => f.type.startsWith("image/"))].slice(0, MAX_IMAGES));
  const stopTyping = () => {
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = null; setTyping(false); }
  };
  const onChange = (v: string) => {
    setText(v);
    if (!typingTimer.current) setTyping(true);
    else clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };
  const submit = () => {
    const body = text.trim();
    if (disabled || (!body && files.length === 0)) return;
    stopTyping();
    void send(body, files);
    setText("");
    setFiles([]);
  };

  return (
    <div className="flex flex-col gap-2 border-t p-3" style={{ borderColor: "var(--color-border)" }}>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}:${i}`} className="flex items-center gap-1 rounded-md bg-[var(--color-bg-secondary)] px-2 py-1 text-xs">
              <span className="max-w-40 truncate">{f.name}</span>
              <button
                type="button"
                aria-label={t("support-chat.action.close")}
                className="rounded p-0.5 hover:bg-[var(--color-bg-tertiary)]"
                onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={text}
        disabled={disabled}
        rows={2}
        placeholder={t("support-chat.placeholder.writeAMessage")}
        aria-label={t("support-chat.placeholder.writeAMessage")}
        className="max-h-32 min-h-12 resize-none rounded-lg border bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]"
        style={{ borderColor: "var(--color-border)" }}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
          if (images.length === 0) return;
          e.preventDefault();
          addFiles(images);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <input
          ref={picker}
          type="file"
          accept={IMAGE_TYPES}
          multiple
          hidden
          onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
        />
        <button
          type="button"
          disabled={disabled || files.length >= MAX_IMAGES}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
          onClick={() => picker.current?.click()}
        >
          <ImagePlus size={14} /> {t("support-chat.action.screenshot")}
        </button>
        <button
          type="button"
          disabled={disabled || (!text.trim() && files.length === 0)}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          onClick={submit}
        >
          <Send size={13} className="rtl:-scale-x-100" /> {t("support-chat.action.send")}
        </button>
      </div>
    </div>
  );
}
