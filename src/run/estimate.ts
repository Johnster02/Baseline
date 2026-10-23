// Best-guess progress for an active phase. Pure: bundled into the band mod, so no Node imports.
// The bar moves with time toward 95% and jumps forward whenever a real milestone is reported.

/** How long each phase usually takes, in seconds, per run size. PR runs aim for 5 minutes in all. */
const EXPECTED_S: Record<string, { pr: number; quick: number; full: number }> = {
  gather: { pr: 45, quick: 90, full: 150 },
  "read-code": { pr: 120, quick: 180, full: 360 },
  explore: { pr: 180, quick: 360, full: 720 },
  verdicts: { pr: 45, quick: 120, full: 240 },
  refute: { pr: 60, quick: 150, full: 300 },
  "clean-up": { pr: 45, quick: 90, full: 150 },
};
/** The estimate never claims a phase is finished; only marking it done does. */
const CAP = 95;

export type EstimateInput = { name: string; status: string; pct?: number | undefined; since?: string | undefined; pctAt?: string | undefined };

export function estimatePct(ph: EstimateInput, size: string, now: number): number {
  const base = Math.max(0, Math.min(100, Number(ph.pct) || 0));
  if (ph.status !== "active" || base >= CAP) return base;
  const from = Date.parse(ph.pctAt ?? ph.since ?? "");
  if (!Number.isFinite(from)) return base;
  const total = (EXPECTED_S[ph.name]?.[size === "full" || size === "pr" ? size : "quick"] ?? 120) * 1000;
  // Time left scales with work left, so a phase at 80% doesn't wait a whole phase for the next tick.
  const left = Math.max(15000, total * (1 - base / 100));
  const t = Math.max(0, now - from) / left;
  // Ease out: about 78% of the remaining gap after the expected time, then slows near the cap.
  return base + (CAP - base) * (1 - Math.exp(-1.5 * t));
}
