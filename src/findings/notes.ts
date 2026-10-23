import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../core/json";
import { notesFileSchema, parse } from "../run/schemas";
import type { Note } from "../run/schemas";

/** Finding ids are renumbered every run, so a note also keeps the title and screen it was about. */
export type { Note };
const file = (p: string) => join(p, ".baseline", "notes.json");

export function listNotes(projectDir: string): Note[] {
  return readJsonFile(file(projectDir), parse(notesFileSchema), []);
}

/** A "not applicable" note about the site. Later runs read these so the same noise doesn't come back. */
export function addNote(projectDir: string, findingId: string, text: string, about?: { title?: string; route?: string }): Note {
  const n: Note = { findingId, ...(about?.title ? { title: about.title } : {}), ...(about?.route ? { route: about.route } : {}), text, at: new Date().toISOString() };
  const all = [...listNotes(projectDir), n];
  mkdirSync(join(projectDir, ".baseline"), { recursive: true });
  writeJsonAtomic(file(projectDir), all);
  return n;
}
