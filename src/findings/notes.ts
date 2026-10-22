import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Finding ids are renumbered every run, so a note also keeps the title and screen it was about. */
export type Note = { findingId: string; title?: string; route?: string; text: string; at: string };
const file = (p: string) => join(p, ".baseline", "notes.json");

export function listNotes(projectDir: string): Note[] {
  try { return JSON.parse(readFileSync(file(projectDir), "utf8")); } catch { return []; }
}

/** A "not applicable" note about the site. Later runs read these so the same noise doesn't come back. */
export function addNote(projectDir: string, findingId: string, text: string, about?: { title?: string; route?: string }): Note {
  const n: Note = { findingId, ...(about?.title ? { title: about.title } : {}), ...(about?.route ? { route: about.route } : {}), text, at: new Date().toISOString() };
  const all = [...listNotes(projectDir), n];
  mkdirSync(join(projectDir, ".baseline"), { recursive: true });
  writeFileSync(file(projectDir), JSON.stringify(all, null, 2));
  return n;
}
