/**
 * The legal notice shown on the desktop authentication pages.
 *
 * Mirrors apps/web/src/components/legal-notice.tsx so the wording cannot drift
 * between the two clients. Both documents are named deliberately: the Terms are
 * the contract, and the Privacy Policy is the notice owed at the point personal
 * data is collected, which is exactly what a sign-up form does.
 *
 * These are BUTTONS, not anchors. An <a href> inside the renderer would try to
 * navigate the app window off its own origin (the will-navigate handler in
 * src/main/index.ts blocks that outright). `window.open(url, "_blank")` is what
 * the main process intercepts via setWindowOpenHandler and forwards to
 * shell.openExternal, which is the established pattern on ProfilePage.
 */

const TERMS_URL = "https://dosya.dev/terms-of-service";
const PRIVACY_URL = "https://dosya.dev/privacy-policy";

function LegalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.open(href, "_blank")}
      className="underline underline-offset-2 hover:text-[var(--color-text)] transition-colors"
    >
      {children}
    </button>
  );
}

/** Inline sentence naming both documents. Used inside the sign-up consent checkbox. */
export function LegalLinks() {
  return (
    <>
      <LegalLink href={TERMS_URL}>Terms of Service</LegalLink> and acknowledge the{" "}
      <LegalLink href={PRIVACY_URL}>Privacy Policy</LegalLink>
    </>
  );
}

/**
 * Passive notice for pages with no checkbox to tick - the login form and the
 * OAuth buttons above it. Continuing past it is the act of agreement.
 */
export function LegalNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-center text-xs text-[var(--color-text-muted)] ${className}`}>
      By continuing, you agree to our <LegalLink href={TERMS_URL}>Terms of Service</LegalLink> and{" "}
      <LegalLink href={PRIVACY_URL}>Privacy Policy</LegalLink>.
    </p>
  );
}
