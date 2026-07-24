// Ported from apps/web/src/components/text-find-bar.tsx — keep in sync with the web copy.
import { useEffect, useRef } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import type { useInFileFind } from "@/lib/use-in-file-find";

export function TextFindBar({ find, onClose }: { find: ReturnType<typeof useInFileFind>; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) find.prev(); else find.next(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return (
    <div
      role="search"
      className="absolute top-3 right-3 z-20 flex items-center gap-1 rounded-md border bg-[var(--color-bg)]/95 shadow-md px-2 py-1"
      style={{ borderColor: "var(--color-border)" }}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        value={find.query}
        onChange={(e) => find.setQuery(e.target.value)}
        placeholder="Find"
        className="w-40 bg-transparent text-sm outline-none px-1"
        aria-label="Find in file"
      />
      <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums min-w-12 text-center">
        {find.count ? `${find.current}/${find.count}` : (find.query ? "No results" : "")}
      </span>
      <button className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
        onClick={find.prev} disabled={!find.count} title="Previous (Shift+Enter)">
        <ChevronUp size={14} />
      </button>
      <button className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
        onClick={find.next} disabled={!find.count} title="Next (Enter)">
        <ChevronDown size={14} />
      </button>
      <button className="flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-bg-tertiary)]"
        onClick={onClose} title="Close (Esc)">
        <X size={14} />
      </button>
    </div>
  );
}
