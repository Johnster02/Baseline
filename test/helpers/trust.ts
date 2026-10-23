// What `run new` records in the data folder for a run, for tests that open a session on a
// hand-made run folder. Without it, openSession refuses (see core/trusted-run).
import { existsSync, writeFileSync } from "node:fs";
import { trustedFiles } from "../../src/core/paths";
import type { ProjectConfig, Runner } from "../../src/config/schema";

export function trustRun(o: { runDir: string; runId?: string; baseUrl: string; cfg: ProjectConfig; runner?: Runner; projectDir?: string; live?: boolean }): void {
  if (!existsSync(trustedFiles.run(o.runDir))) {
    writeFileSync(trustedFiles.run(o.runDir), JSON.stringify({ runDir: o.runDir, projectDir: o.projectDir ?? o.runDir, runId: o.runId ?? "r-test", url: o.baseUrl, live: o.live === true, startedAt: new Date().toISOString() }));
  }
  if (!existsSync(trustedFiles.config(o.runDir))) {
    const runners = o.runner ? [o.runner, ...o.cfg.runners.filter((r) => r.key !== o.runner?.key)] : o.cfg.runners;
    writeFileSync(trustedFiles.config(o.runDir), JSON.stringify({ ...o.cfg, runners }));
  }
}
