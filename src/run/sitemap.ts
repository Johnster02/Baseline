import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../core/json";
import { parse, siteMapSchema } from "./schemas";
import type { SiteMap } from "./schemas";

export type { SiteMap };
const file = (p: string) => join(p, ".baseline", "sitemap.json");

export function readSiteMap(projectDir: string): SiteMap {
  return readJsonFile(file(projectDir), parse(siteMapSchema), { routes: [], notes: [] });
}

/** Check an explorer's partial site map. Throws with a readable message when it is the wrong shape. */
export function parseSiteMap(raw: unknown): SiteMap {
  const r = siteMapSchema.safeParse(raw);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; "));
  return r.data;
}

/** What explorers learned about the site, kept so later runs don't rediscover it. */
export function mergeSiteMap(projectDir: string, partial: SiteMap): SiteMap {
  const m = readSiteMap(projectDir);
  for (const r of partial.routes) {
    const hit = m.routes.find((x) => x.path === r.path);
    if (hit) { hit.title = r.title || hit.title; hit.personas = [...new Set([...hit.personas, ...r.personas])]; }
    else m.routes.push({ path: r.path, title: r.title, personas: [...new Set(r.personas)] });
  }
  m.notes = [...new Set([...m.notes, ...partial.notes])];
  mkdirSync(join(projectDir, ".baseline"), { recursive: true });
  writeJsonAtomic(file(projectDir), m);
  return m;
}
