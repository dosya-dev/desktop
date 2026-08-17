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
        className="anim-modal-panel w-full rounded-xl bg-[var(--color-bg)] p-6 shadow-xl"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      <div className="fixed inset-0 -z-10" onClick={onClose} />
    </div>
  );
}
