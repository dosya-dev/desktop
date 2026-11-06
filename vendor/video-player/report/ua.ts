/** Short "Browser on OS" label for a user agent. Order matters: Edge and Chrome both say Safari. */
export function describeUa(
  ua: string,
  labels: { browser: string; browserOnOs(browser: string, os: string): string } = { browser: 'Browser', browserOnOs: (b, o) => `${b} on ${o}` },
): string {
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : '';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux|X11/.test(ua) ? 'Linux'
    : '';
  if (!browser && !os) return labels.browser;
  return os ? labels.browserOnOs(browser || labels.browser, os) : browser;
}
