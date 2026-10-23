// URL checks with no zod import, so the guard and the hook can use them without loading schemas.

/** Hostname without a trailing dot, lowercased. Protocol and port are ignored on purpose:
 *  http://shop and https://shop:8443 are the same production site. */
export function hostKey(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/\.$/, "").toLowerCase() || undefined; } catch { return undefined; }
}

export function isProduction(url: string, cfg: { productionUrls: readonly string[] }): boolean {
  const h = hostKey(url);
  if (!h) return false;
  return cfg.productionUrls.some((p) => {
    const ph = hostKey(p);
    return !!ph && (h === ph || h.endsWith("." + ph));
  });
}

export function checkTarget(url: string, cfg: { productionUrls: readonly string[] }, live: boolean): { ok: true } | { ok: false; reason: "production" | "invalid" } {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: "invalid" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: "invalid" };
  if (isProduction(url, cfg) && !live) return { ok: false, reason: "production" };
  return { ok: true };
}
