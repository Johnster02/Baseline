import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The nearest folder at or above `start` that holds a Baseline project (.baseline/config.json). */
export function findProjectRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".baseline", "config.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}
