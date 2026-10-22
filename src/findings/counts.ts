export type Counts = {
  checked: number; passed: number; passRate: number;
  conflicts: number; product: number; unspecced: number; unverified: number; skipped: number;
};

export const emptyCounts = (): Counts => ({ checked: 0, passed: 0, passRate: 0, conflicts: 0, product: 0, unspecced: 0, unverified: 0, skipped: 0 });

import type { Finding } from "./schema";
import { isConflict } from "./schema";

type BlockedLike = { runner: string; category: string; method: string; path: string };

/** Pass rate = matches over everything checked (skipped items are not checks). Skipped counts unique blocked actions. */
export function countRun(fs: Finding[], blocked: BlockedLike[]): Counts {
  const checked = fs.filter((f) => f.verdict !== "skipped");
  const passed = checked.filter((f) => f.verdict === "match").length;
  const uniqueBlocked = new Set(blocked.map((b) => `${b.runner}|${b.category}|${b.method}|${b.path}`)).size;
  return {
    checked: checked.length,
    passed,
    passRate: checked.length ? Math.round((passed / checked.length) * 100) : 0,
    conflicts: fs.filter((f) => isConflict(f.verdict)).length,
    product: fs.filter((f) => f.verdict === "product").length,
    unspecced: fs.filter((f) => f.verdict === "unspecced").length,
    unverified: fs.filter((f) => f.verdict === "unverified").length,
    skipped: uniqueBlocked + fs.filter((f) => f.verdict === "skipped").length,
  };
}
