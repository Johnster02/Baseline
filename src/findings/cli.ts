import { register, out, err } from "../cli";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addNote, listNotes } from "./notes";

/** The finding in the latest run with this id, for its title and screen. */
function findFinding(id: string): { title?: string; route?: string } | undefined {
  const base = join(process.cwd(), ".baseline");
  for (const pointer of ["active-run", "last-run"]) {
    try {
      const runDir = readFileSync(join(base, pointer), "utf8").trim();
      const all = JSON.parse(readFileSync(join(runDir, "findings.json"), "utf8")) as { id: string; title?: string; route?: string }[];
      const f = all.find((x) => x.id === id);
      if (f) return { title: f.title, route: f.route };
    } catch { /* try the next */ }
  }
  return undefined;
}

register("dismiss", "record that a finding is not applicable: dismiss <finding-id> \"<reason>\" | dismiss --list", (args) => {
  if (args[0] === "--list") { out(JSON.stringify(listNotes(process.cwd()), null, 2)); return 0; }
  const [id, ...reason] = args;
  if (!id || !reason.join(" ").trim()) { err('usage: baseline dismiss <finding-id> "<why it does not apply>"'); return 2; }
  addNote(process.cwd(), id, reason.join(" ").trim(), findFinding(id));
  out(`noted: ${id} will be treated as not applicable on later runs`);
  return 0;
});
