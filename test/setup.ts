// Every test file gets its own Baseline data folder, so tests never write guard state, hosts or
// secrets into the real one. Specs that need a specific folder still set BASELINE_DATA themselves.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BASELINE_DATA = mkdtempSync(join(tmpdir(), "baseline-data-"));
