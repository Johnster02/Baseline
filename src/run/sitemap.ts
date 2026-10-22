import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SiteMap = { routes: { path: string; title: string; personas: string[] }[]; notes: string[] };
const file = (p: string) => join(p, ".baseline", "sitemap.json");

export function readSiteMap(projectDir: string): SiteMap {
  try { return JSON.parse(readFileSync(file(projectDir), "utf8")); } catch { return { routes: [], notes: [] }; }
}

/** What explorers learned about the site, kept so later runs don't rediscover it. */
export function mergeSiteMap(projectDir: string, partial: SiteMap): SiteMap {
  const m = readSiteMap(projectDir);
  for (const r of partial.routes ?? []) {
    const hit = m.routes.find((x) => x.path === r.path);
    if (hit) { hit.title = r.title || hit.title; hit.personas = [...new Set([...hit.personas, ...r.personas])]; }
    else m.routes.push({ path: r.path, title: r.title, personas: [...new Set(r.personas)] });
  }
  m.notes = [...new Set([...m.notes, ...(partial.notes ?? [])])];
  mkdirSync(join(projectDir, ".baseline"), { recursive: true });
  writeFileSync(file(projectDir), JSON.stringify(m, null, 2));
  return m;
}
