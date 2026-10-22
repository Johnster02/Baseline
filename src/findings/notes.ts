import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Note = { findingId: string; text: string; at: string };
const file = (p: string) => join(p, ".baseline", "notes.json");

export function listNotes(projectDir: string): Note[] {
  try { return JSON.parse(readFileSync(file(projectDir), "utf8")); } catch { return []; }
}

/** A "not applicable" note about the site. Later runs read these so the same noise doesn't come back. */
export function addNote(projectDir: string, findingId: string, text: string): Note {
  const n: Note = { findingId, text, at: new Date().toISOString() };
  const all = [...listNotes(projectDir), n];
  mkdirSync(join(projectDir, ".baseline"), { recursive: true });
  writeFileSync(file(projectDir), JSON.stringify(all, null, 2));
  return n;
}
