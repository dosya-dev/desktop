/**
 * Memoizes the system/corporate-proxy lookup `resolveAgent()` makes on every
 * request (DSK-012).
 *
 * `EnvProvider.resolveProxy` goes out to the OS (PAC file evaluation, registry
 * / gsettings reads depending on platform) - it is not a free call, and
 * `resolveAgent` ran it unconditionally for every HTTP request the client
 * made, including the thousands fired during a large sync. The answer only
 * changes when the network itself changes (switching Wi-Fi, VPN on/off,
 * corporate proxy reconfigured), so re-resolving per request bought nothing
 * but OS round-trips.
 *
 * A TTL window is the fix: same shape as op-count-cache.ts,
 * async because `resolveProxy` is. `RemoteClient` holds one instance per
 * client (not a module-level singleton) so it dies with the client, and
 * clears it on the narrower set of signals `notifyNetworkOnline()` actually
 * gets (reconnect-after-outage, wake-from-sleep) - see `clearProxyCache()`
 * and that method's own comment for what this does and does not cover.
 * Anything outside that set rides out `ttlMs`, which is why the TTL exists
 * at all rather than being purely an optimization.
 *
 * KEYED BY origin + pathname, not by origin. The caller passes the whole URL
 * to `resolveProxy`, and a PAC's `FindProxyForURL(url, host)` may branch on
 * the path, so an origin-only key would let the first request to a host pick
 * the proxy for every path on it - a misroute, not just a slower route. This
 * module does not care what the key means, but the distinction is the reason
 * the hit rate is lower than it looks: see `resolveAgent` in remote-client.ts.
 *
 * No electron imports: this is a pure leaf so plain `node --test` can load it.
 */
export interface ProxyCache {
  get(key: string, compute: () => Promise<string | null>): Promise<string | null>;
  clear(): void;
}

export function createProxyCache(ttlMs: number, now: () => number = Date.now): ProxyCache {
  const entries = new Map<string, { at: number; value: string | null }>();
  return {
    async get(key: string, compute: () => Promise<string | null>): Promise<string | null> {
      const hit = entries.get(key);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      // Not cached until compute() resolves: a rejected lookup (e.g. a PAC
      // evaluation error) must not poison the entry for the TTL window - the
      // next request should get a fresh chance to resolve the proxy.
      const value = await compute();
      entries.set(key, { at: t, value });
      return value;
    },
    clear(): void { entries.clear(); },
  };
}
