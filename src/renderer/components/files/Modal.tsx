/** Shared modal shell for the files surfaces - same look as the page-level dialogs. */
export function Modal({
  children,
  onClose,
  maxWidth = 448,
}: {
  children: React.ReactNode;
  onClose: () => void;
  maxWidth?: number;
}) {
  return (
    <div className="anim-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        // overflow-wrap is inherited: a file name quoted in any dialog's
        // copy is one unbreakable word, and without this it ran past the
        // panel's border. Truncated rows (white-space: nowrap) are unaffected.
        className="anim-modal-panel mx-4 w-full min-w-0 rounded-xl bg-[var(--color-bg)] p-6 shadow-xl [overflow-wrap:anywhere]"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}
