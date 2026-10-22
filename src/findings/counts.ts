export type Counts = {
  checked: number; passed: number; passRate: number;
  conflicts: number; product: number; unspecced: number; unverified: number; skipped: number;
};

export const emptyCounts = (): Counts => ({ checked: 0, passed: 0, passRate: 0, conflicts: 0, product: 0, unspecced: 0, unverified: 0, skipped: 0 });
