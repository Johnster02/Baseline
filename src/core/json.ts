// Small, dependency-free file helpers shared by every area. Kept free of zod so the hook bundle
// stays tiny: callers pass a parse function (a zod schema's `.parse` works).
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type Parse<T> = (v: unknown) => T;

/** Read and check a JSON file. A missing, unreadable or invalid file gives `fallback`. */
export function readJsonFile<T>(path: string, parse: Parse<T>, fallback: T): T {
  try { return parse(JSON.parse(readFileSync(path, "utf8"))); } catch { return fallback; }
}

/** Write JSON via a temp file and rename, so a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown, mode?: number): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/** Append one record as a JSON line. Small appends are atomic, so parallel writers don't lose entries. */
export function appendJsonl(path: string, item: unknown, mode?: number): void {
  appendFileSync(path, JSON.stringify(item) + "\n", mode === undefined ? undefined : { mode });
}

/** Read a JSON-lines file. Bad lines (a torn last write) are skipped; `parse` filters records. */
export function readJsonl<T = unknown>(path: string, parse?: Parse<T>): T[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const items: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      items.push(parse ? parse(v) : (v as T));
    } catch { /* skip */ }
  }
  return items;
}

/** A readable message from anything thrown. */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
