// Every test file gets its own Baseline data folder, so tests never write guard state, hosts or
// secrets into the real one. Specs that need a specific folder still set BASELINE_DATA themselves.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "baseline-data-")));

/**
 * A temp folder with symlinks resolved. On macOS `tmpdir()` is under /var/folders, a symlink to
 * /private/var/folders, while the code under test calls realPath — so a raw mkdtemp path and the
 * path the code reports back are different strings (spec 4). Use this in tests, not mkdtempSync.
 */
export function tmpDir(prefix = "baseline-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
