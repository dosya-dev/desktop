/** `#/about` on the renderer's base URL, whatever hash it already carries. */
export function aboutUrl(rendererUrl: string): string {
  const base = rendererUrl.split("#")[0];
  return `${base}#/about`;
}
