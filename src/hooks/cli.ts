// `baseline hook <name>`: the SessionStart hook, plus the guard hooks for callers that use the CLI.
// hooks.json runs the guards from dist/hook.cjs, which skips loading the rest of the engine.
import { register, err, io } from "../cli";
import { recordPluginData } from "../core/paths";
import { storeTrackersFromEnv } from "../inputs/trackers";
import { isGuardHook, safeGuardHook } from "./handlers";

register("hook", "internal: hook handlers (store-options, bash-guard, tool-guard, read-guard, write-guard)", (args) => {
  const name = args[0] ?? "";
  if (name === "store-options") {
    if (process.env.CLAUDE_PLUGIN_DATA) recordPluginData(process.env.CLAUDE_PLUGIN_DATA);
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
