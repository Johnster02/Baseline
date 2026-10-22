import type { Finding } from "./schema";
import { isConflict, severityRank } from "./schema";

const NEEDS_CODE = new Set(["spec-built", "not-built"]);
const hasEvidence = (f: Finding) => !!(f.observed && (f.observed.shots.length || f.observed.steps.length)) || !!f.built?.ref;
const worstFirst = (a: Finding, b: Finding) => severityRank(a.severity) - severityRank(b.severity);

/**
 * Noise control (spec 3.6a), in order: refuter drops; no evidence or no code means unverified;
 * duplicates across personas merge; related findings are all kept; unrelated ones are capped.
 */
export function filterFindings(fs: Finding[], opts: { otherCap: number; codeRead: boolean }) {
  const dropped = fs.filter((f) => f.refuter && !f.refuter.kept);
  let live = fs.filter((f) => !f.refuter || f.refuter.kept).map((f) => ({ ...f, personas: [...f.personas] }));

  live = live.map((f) => {
    if (!opts.codeRead && NEEDS_CODE.has(f.verdict)) return { ...f, verdict: "unverified" as const };
    if ((isConflict(f.verdict) || f.verdict === "product") && !hasEvidence(f)) return { ...f, verdict: "unverified" as const };
    return f;
  });

  // Same issue = same screen, same verdict, same requirement; for observations outside the spec
  // (unspecced, product) also the same checklist item and title, since they share no requirement.
  const OBSERVATION = new Set(["unspecced", "product"]);
  const key = (f: Finding) => [f.route, f.verdict, f.specced.ref,
    OBSERVATION.has(f.verdict) ? `${f.checklistItem ?? ""}|${f.title.trim().toLowerCase()}` : ""].join("\u0000");
  const merged: Finding[] = [];
  for (const f of live) {
    const twin = f.route && merged.find((m) => key(m) === key(f));
    if (!twin) { merged.push({ ...f, ...(f.observed ? { observed: { ...f.observed, shots: [...f.observed.shots], steps: [...f.observed.steps] } } : {}) }); continue; }
    twin.personas = [...new Set([...twin.personas, ...f.personas])];
    if (severityRank(f.severity) < severityRank(twin.severity)) twin.severity = f.severity;
    if (f.observed) {
      twin.observed ??= { text: f.observed.text, shots: [], steps: [] };
      twin.observed.shots = [...new Set([...twin.observed.shots, ...f.observed.shots])];
      if (!twin.observed.steps.length) twin.observed.steps = [...f.observed.steps];
    }
  }

  const kept = merged.filter((f) => f.scope === "related").sort(worstFirst);
  const unrelated = merged.filter((f) => f.scope === "unrelated").sort(worstFirst);
  return { kept, other: unrelated.slice(0, opts.otherCap), otherHidden: Math.max(0, unrelated.length - opts.otherCap), dropped };
}
