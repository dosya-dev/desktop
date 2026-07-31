/**
 * True when this binary was packaged for the Mac App Store.
 *
 * Electron sets `process.mas` only in MAS builds, so this needs no build-time
 * define and no env var. Everything that must behave differently under the
 * App Sandbox routes through this function so tests can fake it.
 */
export function isMasBuild(): boolean {
  return (process as NodeJS.Process & { mas?: boolean }).mas === true;
}
