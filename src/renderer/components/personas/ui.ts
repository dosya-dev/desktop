// apps/desktop/src/renderer/components/personas/ui.ts
//
// The button and border styles the Personas screens share (the desktop's
// page-level dialog look).
export const PRIMARY_BUTTON = "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] disabled:cursor-not-allowed disabled:opacity-50";
export const OUTLINE_BUTTON = "inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium hover:bg-[var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50";
export const DANGER_BUTTON = "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50";
export const SMALL = "px-3 py-1.5";
export const BORDER = { borderColor: "var(--color-border)" } as const;
/** An external link in the app's accent (Main's setWindowOpenHandler sends https links to the system browser). */
export const EXTERNAL_LINK = "text-xs font-medium text-[var(--color-primary)] underline underline-offset-2 hover:opacity-80";
