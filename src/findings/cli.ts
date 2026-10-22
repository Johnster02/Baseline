import { register, out, err } from "../cli";
import { addNote, listNotes } from "./notes";

register("dismiss", "record that a finding is not applicable: dismiss <finding-id> \"<reason>\" | dismiss --list", (args) => {
  if (args[0] === "--list") { out(JSON.stringify(listNotes(process.cwd()), null, 2)); return 0; }
  const [id, ...reason] = args;
  if (!id || !reason.join(" ").trim()) { err('usage: baseline dismiss <finding-id> "<why it does not apply>"'); return 2; }
  addNote(process.cwd(), id, reason.join(" ").trim());
  out(`noted: ${id} will be treated as not applicable on later runs`);
  return 0;
});
