// `baseline hook <name>`: the SessionStart hook, plus the guard hooks for callers that use the CLI.
// hooks.json runs the guards from dist/hook.cjs, which skips loading the rest of the engine.
import { homedir } from "node:os";
import { join } from "node:path";
import { register, err, io } from "../cli";
import { recordPluginData } from "../core/paths";
import { migrateLegacyData } from "../core/migrate";
import { storeTrackersFromEnv } from "../inputs/trackers";
import { isGuardHook, safeGuardHook } from "./handlers";

register("hook", "internal: hook handlers (store-options, bash-guard, tool-guard, read-guard, write-guard)", (args) => {
  const name = args[0] ?? "";
  if (name === "store-options") {
    const target = process.env.CLAUDE_PLUGIN_DATA;
    if (target) {
      recordPluginData(target);
      // Anything saved while the two folders were out of step (spec 3.1) comes across now, so a
      // login taken by one command is visible to every other one. Never fails the session.
      try { migrateLegacyData({ legacy: join(process.env.HOME || homedir(), ".config", "baseline"), target }); } catch { /* best effort */ }
    }
    storeTrackersFromEnv(process.env);
    return 0;
  }
  if (isGuardHook(name)) {
    let stdin = "";
    try { stdin = io.readStdin(); } catch { return 0; }
    const res = safeGuardHook(name, stdin);
    if (res.deny) err(res.deny);
    return res.code;
  }
  err("unknown hook");
  return 2;
});
