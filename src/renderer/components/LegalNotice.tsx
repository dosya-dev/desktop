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

import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "../../i18n/keys";

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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One translated sentence with each document's name turned into its link.
 * The sentence is a single catalog message with no placeholders, so the
 * names are found in it by their own catalog labels, ignoring case
 * ("conditions d’utilisation" mid-sentence). A translation that words a name
 * differently keeps its sentence whole and gets that link after it, so a
 * document is never unreachable.
 */
function LinkedSentence({ messageKey }: { messageKey: MessageKey }) {
  const t = useT();
  const text = t(messageKey);
  const docs = [
    { name: t("profile.label.termsOfService"), href: TERMS_URL },
    { name: t("profile.label.privacyPolicy"), href: PRIVACY_URL },
  ];
  const found: { start: number; end: number; href: string }[] = [];
  const missing: { name: string; href: string }[] = [];
  for (const doc of docs) {
    const m = new RegExp(escapeRe(doc.name), "iu").exec(text);
    const start = m?.index ?? -1;
    if (m && !found.some((f) => start < f.end && f.start < start + m[0].length)) {
      found.push({ start, end: start + m[0].length, href: doc.href });
    } else {
      missing.push(doc);
    }
  }
  found.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const f of found) {
    nodes.push(text.slice(at, f.start));
    nodes.push(<LegalLink key={f.href} href={f.href}>{text.slice(f.start, f.end)}</LegalLink>);
    at = f.end;
  }
  nodes.push(text.slice(at));
  for (const doc of missing) {
    nodes.push(" ", <LegalLink key={doc.href} href={doc.href}>{doc.name}</LegalLink>);
  }
  return <>{nodes}</>;
}

/**
 * The sign-up consent sentence ("I agree to the Terms of Service and
 * acknowledge the Privacy Policy"), whole and in the chosen language.
 */
export function LegalConsent() {
  return <LinkedSentence messageKey="sign-up.label.iAgreeToTheTermsOfServiceAndAcknowledge" />;
}

/**
 * Passive notice for pages with no checkbox to tick - the login form and the
 * OAuth buttons above it. Continuing past it is the act of agreement.
 */
export function LegalNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-center text-xs text-[var(--color-text-muted)] ${className}`}>
      <LinkedSentence messageKey="common.description.byContinuingYouAgreeToOurTermsOfService" />
    </p>
  );
}
