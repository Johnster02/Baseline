// One schema per file a run reads, so a hand-edited or half-written file can't crash a command or
// feed it wrong data. Types come from the schemas. Keep this out of anything bundled into the mod
// (mod/frame.ts, render/terminal.ts): those import types only.
import { z } from "zod";
import { INPUT_KINDS } from "../inputs/resolve";

const inputKind = z.enum(INPUT_KINDS);
export const inputRefSchema = z.object({ kind: inputKind, ref: z.string() });

const permission = z.object({ runner: z.string(), can: z.array(z.string()), cannot: z.array(z.string()), notes: z.array(z.string()).optional() });

/** <runDir>/run.json, written by `run new`. */
export const runFileSchema = z.object({
  schemaVersion: z.number().optional(),
  runId: z.string(),
  url: z.string(),
  label: z.string(),
  startedAt: z.string(),
  permissions: z.array(permission).default([]),
  live: z.boolean().default(false),
});
export type RunFile = z.infer<typeof runFileSchema>;

/** <runDir>/inputs.json, written by `inputs`. */
export const inputsFileSchema = z.object({
  items: z.array(z.object({
    ref: inputRefSchema,
    title: z.string().default(""),
    body: z.string().optional(),
    links: z.array(z.string()).default([]),
    changedFiles: z.array(z.string()).optional(),
    headSha: z.string().optional(),
    files: z.array(z.string()).optional(),
  })).default([]),
  unreadLinks: z.array(z.string()).default([]),
});
export type InputsFile = z.infer<typeof inputsFileSchema>;

/** <runDir>/commit.json, written by `commit --out`. */
export const commitFileSchema = z.object({
  codeRead: z.boolean(),
  commitRead: z.string().optional(),
  deployed: z.string().optional(),
  mismatch: z.boolean(),
});

/** <runDir>/runners.json: each runner's sign-in status this run. */
export const runnersFileSchema = z.array(z.object({ key: z.string(), ok: z.boolean(), error: z.string().optional() }));

/** <runDir>/cleanup.json, written by the cleaner agent. */
export const cleanupFileSchema = z.array(z.object({ label: z.string(), removed: z.boolean(), note: z.string().optional() }));

/** Blocked-request log entries (JSONL, one per line). */
export const blockedEntrySchema = z.object({
  at: z.string(), runner: z.string(), method: z.string(), host: z.string(), path: z.string(),
  category: z.string(), reason: z.string(), trigger: z.string().optional(),
});
export type BlockedRecord = z.infer<typeof blockedEntrySchema>;

/** <project>/.baseline/sitemap.json, and the partial an explorer hands to `sitemap merge`. */
const route = z.object({ path: z.string(), title: z.string().default(""), personas: z.array(z.string()).default([]) });
export const siteMapSchema = z.object({ routes: z.array(route).default([]), notes: z.array(z.string()).default([]) });
export type SiteMap = z.infer<typeof siteMapSchema>;

/** <project>/.baseline/notes.json. */
export const noteSchema = z.object({ findingId: z.string(), title: z.string().optional(), route: z.string().optional(), text: z.string(), at: z.string() });
export const notesFileSchema = z.array(noteSchema);
export type Note = z.infer<typeof noteSchema>;

const phaseStatus = z.enum(["pending", "active", "done", "skipped"]);
const countsSchema = z.object({
  checked: z.number(), passed: z.number(), passRate: z.number().nullable(),
  conflicts: z.number(), product: z.number(), unspecced: z.number(), unverified: z.number(), skipped: z.number(),
});
/** <runDir>/progress.json. The live band reads it too. */
export const progressFileSchema = z.object({
  runId: z.string(),
  label: z.string(),
  size: z.enum(["pr", "quick", "full"]),
  agents: z.number(),
  startedAt: z.string(),
  phases: z.array(z.object({
    name: z.enum(["gather", "read-code", "explore", "verdicts", "refute", "clean-up"]),
    status: phaseStatus,
    pct: z.number().optional(), note: z.string().optional(), since: z.string().optional(), pctAt: z.string().optional(),
  })),
  active: z.array(z.object({ persona: z.string(), doing: z.string() })),
  counts: countsSchema,
  finishedAt: z.string().optional(),
});

/** Parse functions for readJsonFile. */
export const parse = <S extends z.ZodType>(s: S) => (v: unknown): z.infer<S> => s.parse(v);
