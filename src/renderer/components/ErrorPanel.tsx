/**
 * The one contract for a page-level load failure: say what failed, offer a
 * retry. Pages render this instead of inventing their own error prose, so
 * recovery is a pattern users learn once.
 */
export function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <p className="text-sm text-[var(--color-text-secondary)]">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border px-4 py-1.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)]"
          style={{ borderColor: "var(--color-border)" }}
        >
          Try again
        </button>
      )}
    </div>
  );
}
