import { useNavigate } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";
import { INTEGRATIONS, TOOLS } from "@/lib/integrations";
import { webAppUrl } from "@/lib/web-app-url";

/**
 * Integrations - the desktop counterpart to apps/web's /integrations.
 *
 * Two sections, ordered by what actually happens when you click:
 *
 *  1. Built-in tools run natively here and navigate in-app.
 *  2. Connection cards open their setup guide in the browser. The guides carry
 *     API keys, code samples and OAuth flows that only exist on web, so this
 *     hands off rather than reimplementing them - the same window.open pattern
 *     SettingsPage and ProfilePage already use for billing and roles. Desktop
 *     users are the ones most likely to mount WebDAV or point rclone at a
 *     workspace, so hiding these cards would cost more than it saves.
 */

/** Shared card chrome. The stretched link overlay is the last child so it sits
 *  above the static content, while "Read docs" (z-10) stays clickable. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="group relative flex flex-col rounded-xl border p-4 transition-colors hover:border-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]"
      style={{ borderColor: "var(--color-border)" }}
    >
      {children}
    </div>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span className="inline-flex w-fit items-center rounded-full bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
      {label}
    </span>
  );
}

export function IntegrationsPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Built-in tools, and ways to connect other apps to your workspace
        </p>
      </div>

      {/* Built-in tools */}
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Built-in tools</h2>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            Included with your workspace - no setup needed.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((t) => (
            <Card key={t.to}>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)]">
                  <t.icon size={18} />
                </div>
                <ArrowRight
                  size={16}
                  className="-translate-x-1 text-[var(--color-text-muted)] opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
                />
              </div>
              <p className="text-sm font-semibold">{t.title}</p>
              <p className="mt-1 flex-1 text-xs text-[var(--color-text-muted)]">{t.description}</p>
              <div className="mt-3">
                <Tag label={t.tag} />
              </div>
              <button
                data-testid={`tool-card-${t.to.replace("/", "")}`}
                onClick={() => navigate(t.to)}
                className="absolute inset-0 rounded-xl"
                aria-label={`Open ${t.title}`}
              />
            </Card>
          ))}
        </div>
      </section>

      {/* Connection cards - these hand off to the web app */}
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Connect external tools</h2>
          <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
            Setup guides open in your browser, where your API keys live.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {INTEGRATIONS.map((it) => (
            <Card key={it.slug}>
              <div className="mb-3 flex items-center justify-between">
                <div className="flex size-9 items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)]">
                  {it.iconSrc ? (
                    <img src={it.iconSrc} alt="" className="size-4.5" />
                  ) : (
                    <it.icon size={18} />
                  )}
                </div>
                <ExternalLink
                  size={16}
                  className="text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
              <p className="text-sm font-semibold">{it.title}</p>
              <p className="mt-1 flex-1 text-xs text-[var(--color-text-muted)]">{it.description}</p>
              <div className="mt-3 flex items-center justify-between gap-2">
                <Tag label={it.tag} />
                {it.docsUrl && (
                  <button
                    onClick={() => window.open(it.docsUrl, "_blank")}
                    className="relative z-10 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    Read docs <ExternalLink size={11} />
                  </button>
                )}
              </div>
              <button
                data-testid={`integration-card-${it.slug}`}
                onClick={() => window.open(webAppUrl(`/integrations/${it.slug}`), "_blank")}
                className="absolute inset-0 rounded-xl"
                aria-label={`Open ${it.title} setup`}
              />
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
