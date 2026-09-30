// Ported from apps/web/src/components/live-badge.tsx - keep in sync
/**
 * The Live Photo marker: Apple's concentric-circles glyph plus the word LIVE,
 * in the same black-45% pill the grid uses for the extension. `pill` is the
 * list-view variant on the page ground; `glyph` is for 44px filmstrip thumbs.
 */
export function LiveBadge({ size, className = '', style }: { size: 'tile' | 'pill' | 'glyph'; className?: string; style?: React.CSSProperties }) {
  const glyph = (
    <svg viewBox="0 0 12 12" width={size === 'glyph' ? 8 : 10} height={size === 'glyph' ? 8 : 10} aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6" r="2.6" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="1.2 1.1" />
    </svg>
  );
  if (size === 'pill') {
    // --brand-text is a raw token in index.css (not a Tailwind utility), so it
    // is applied inline. Green as TEXT, never the green fill, per DESIGN.md.
    return (
      <span data-testid="live-badge" aria-label="Live Photo" style={{ color: 'var(--brand-text)', borderColor: 'var(--brand-text)', ...style }} className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider ${className}`}>
        {glyph}Live
      </span>
    );
  }
  return (
    <span data-testid="live-badge" aria-label="Live Photo" style={style} className={`inline-flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-white backdrop-blur-sm ${className}`}>
      {glyph}{size === 'tile' ? 'LIVE' : null}
    </span>
  );
}
