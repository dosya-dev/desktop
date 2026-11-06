import { Toaster } from "sonner";
import { useDir } from "@/lib/i18n";

const TOAST_OPTIONS = {
  style: {
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
};

/**
 * The app's toaster. Toasts sit in the corner at the inline end of the page:
 * bottom-right in left-to-right languages, bottom-left (with sonner's own
 * layout mirrored) in right-to-left ones. Left-to-right gets exactly the
 * props it always had; sonner then reads the direction off <html> itself.
 */
export function AppToaster() {
  const dir = useDir();
  if (dir === "rtl") return <Toaster position="bottom-left" dir="rtl" toastOptions={TOAST_OPTIONS} />;
  return <Toaster position="bottom-right" toastOptions={TOAST_OPTIONS} />;
}
