/**
 * Base URL for the dosya.dev web app.
 *
 * The desktop app hands a few things off to the browser (roles & permissions,
 * API keys, billing). Those are all *app* routes and live on app.dosya.dev -
 * they do not exist on the marketing site, so linking to dosya.dev/settings,
 * dosya.dev/profile or dosya.dev/billing landed the user on the marketing
 * 404 page. Reported by testers as "Open on web gives a 404".
 */
export const WEB_APP_BASE = "https://app.dosya.dev";

/** Build an absolute URL to a route inside the web app. */
export function webAppUrl(path: string): string {
    return `${WEB_APP_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
