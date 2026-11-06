import { useMemo } from "react";
import { renderMarkdown, isPreviewLink } from "@/lib/md-render";

/**
 * The rendered side of the split. The HTML is sanitized by renderMarkdown
 * before it gets here (see md-render.ts for the policy). Links never navigate
 * the app window: a click is turned into window.open, which the main process
 * hands to the system browser for http(s) and refuses otherwise.
 */
export function MarkdownPreview({
  text,
  ref,
  label,
  onScroll,
}: {
  text: string;
  ref?: React.Ref<HTMLDivElement>;
  label: string;
  onScroll?: () => void;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest?.("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (isPreviewLink(href)) window.open(href!, "_blank");
  };

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      onClick={onClick}
      data-testid="md-preview"
      aria-label={label}
      role="document"
      className="h-full min-h-0 overflow-auto px-7 py-6"
    >
      {/* Sanitized in renderMarkdown: no scripts, handlers, styles or classes. */}
      <div className="md-preview mx-auto max-w-[720px]" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
