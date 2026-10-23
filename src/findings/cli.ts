import { register, out, err } from "../cli";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile } from "../core/json";
import { projectStateDir, readActivePointer } from "../core/paths";
import { readFileSync } from "node:fs";
import { addNote, listNotes } from "./notes";

const findingRefs = z.array(z.object({ id: z.string(), title: z.string().optional(), route: z.string().optional() }).loose());

/** The finding in the latest run with this id, for its title and screen. */
function findFinding(id: string): { title?: string; route?: string } | undefined {
  const lastRun = (() => { try { return readFileSync(join(projectStateDir(process.cwd()), "last-run"), "utf8").trim() || undefined; } catch { return undefined; } })();
  for (const runDir of [readActivePointer(process.cwd()), lastRun]) {
    if (!runDir) continue;
    const f = readJsonFile(join(runDir, "findings.json"), (v) => findingRefs.parse(v), []).find((x) => x.id === id);
    if (f) return { ...(f.title ? { title: f.title } : {}), ...(f.route ? { route: f.route } : {}) };
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
