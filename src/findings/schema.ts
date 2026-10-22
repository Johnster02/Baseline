import { z } from "zod";

export const VERDICTS = ["match", "spec-built", "built-observed", "not-built", "guide-spec", "unspecced", "product", "unverified", "skipped"] as const;
export const CONFLICTS = ["spec-built", "built-observed", "not-built", "guide-spec"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Severity = (typeof SEVERITIES)[number];

export const findingSchema = z.object({
  id: z.string(),
  title: z.string(),
  verdict: z.enum(VERDICTS),
  severity: z.enum(SEVERITIES).default("medium"),
  personas: z.array(z.string()).default([]),
  scope: z.enum(["related", "unrelated"]).default("related"),
  route: z.string().optional(),
  specced: z.object({ text: z.string(), ref: z.string() }),
  built: z.object({ text: z.string(), ref: z.string() }).optional(),
  observed: z.object({ text: z.string(), shots: z.array(z.string()).default([]), steps: z.array(z.string()).default([]) }).optional(),
  refuter: z.object({ kept: z.boolean(), note: z.string().default("") }).optional(),
  checklistItem: z.string().optional(),
});
export type Finding = z.infer<typeof findingSchema>;

export const isConflict = (v: Verdict) => (CONFLICTS as readonly string[]).includes(v);
export const severityRank = (s: Severity) => SEVERITIES.indexOf(s);
