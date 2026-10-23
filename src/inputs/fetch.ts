import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { InputRef } from "./resolve";
import { adfToText } from "./jira";
import type { AdfNode } from "./jira";

export type Fetched = { ref: InputRef; title: string; body: string; links: string[]; changedFiles?: string[]; headSha?: string; files?: string[] };
export type HttpResponse = { ok: boolean; status: number; json(): Promise<unknown> };

export const trackersSchema = z.object({
  jira: z.object({ baseUrl: z.string(), email: z.string().default(""), token: z.string() }).optional(),
  linear: z.object({ apiKey: z.string() }).optional(),
});
export type Trackers = z.infer<typeof trackersSchema>;

/** Every tracker call gives up after this long, so a hung server can't stall a run. */
export const HTTP_TIMEOUT_MS = 20_000;

const ghPrSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  files: z.array(z.object({ path: z.string() })).nullish(),
  headRefOid: z.string().nullish(),
});
const ghIssueSchema = z.object({ title: z.string(), body: z.string().nullish() });
const adfSchema: z.ZodType<AdfNode> = z.lazy(() => z.object({ type: z.string().optional(), text: z.string().optional(), content: z.array(adfSchema).optional() }));
const jiraIssueSchema = z.object({ fields: z.object({ summary: z.string().nullish(), description: adfSchema.nullish() }).nullish() });
const linearSchema = z.object({
  data: z.object({ issue: z.object({ identifier: z.string(), title: z.string(), description: z.string().nullish() }).nullish() }).nullish(),
});

/** Parse a tracker response, with an error that names the source instead of a zod dump. */
function check<S extends z.ZodType>(schema: S, value: unknown, source: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${source} sent a response Baseline doesn't understand (${r.error.issues[0]?.path.join(".") || "body"}: ${r.error.issues[0]?.message ?? "invalid"})`);
  return r.data;
}

/** A token sent over plain http can be read on the network. Returns a warning, or undefined. */
export function insecureTrackerWarning(t: Trackers): string | undefined {
  if (t.jira?.baseUrl && /^http:\/\//i.test(t.jira.baseUrl.trim())) return `warning: the Jira URL ${t.jira.baseUrl} is plain http, so your Jira token is sent unencrypted. Use https.`;
  return undefined;
}
export type FetchEnv = {
  exec?: (cmd: string, args: string[]) => Promise<string>;
  http?: (url: string, init: RequestInit) => Promise<HttpResponse>;
  trackers?: Trackers;
};

const SPEC_EXT = new Set([".md", ".markdown", ".txt", ".html", ".htm", ".pdf", ".rst", ".adoc"]);
const defaultExec = async (cmd: string, args: string[]) => (await promisify(execFile)(cmd, args, { maxBuffer: 20 * 1024 * 1024 })).stdout;

export function extractLinks(body: string, exclude?: string): string[] {
  const found = body.match(/https?:\/\/[^\s)>\]"'`]+/g) ?? [];
  return [...new Set(found.map((l) => l.replace(/[.,;:]+$/, "")))].filter((l) => l !== exclude);
}

export async function fetchInput(ref: InputRef, env: FetchEnv): Promise<Fetched> {
  const exec = env.exec ?? defaultExec;
  const http = env.http ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }));
  switch (ref.kind) {
    case "github-pr": {
      try {
        const j = check(ghPrSchema, JSON.parse(await exec("gh", ["pr", "view", ref.ref, "--json", "title,body,files,headRefOid"])), "gh pr view");
        const body = j.body ?? "";
        return { ref, title: j.title, body, links: extractLinks(body), changedFiles: (j.files ?? []).map((f) => f.path), ...(j.headRefOid ? { headSha: j.headRefOid } : {}) };
      } catch (e) {
        if (/^\d+$/.test(ref.ref)) return fetchInput({ kind: "github-issue", ref: ref.ref }, env);
        throw e;
      }
    }
    case "github-issue": {
      const j = check(ghIssueSchema, JSON.parse(await exec("gh", ["issue", "view", ref.ref, "--json", "title,body"])), "gh issue view");
      const body = j.body ?? "";
      return { ref, title: j.title, body, links: extractLinks(body) };
    }
    case "jira": {
      const t = env.trackers?.jira;
      if (!t?.baseUrl || !t.token) throw new Error("Jira is not set up. Connect the Jira connector, or add the Jira URL, email and token with /plugin configure baseline.");
      const r = await http(`${t.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(ref.ref)}?fields=summary,description`, {
        headers: { authorization: "Basic " + Buffer.from(`${t.email}:${t.token}`).toString("base64"), accept: "application/json" },
      });
      if (!r.ok) throw new Error(`Jira returned ${r.status} for ${ref.ref}`);
      const j = check(jiraIssueSchema, await r.json(), "Jira");
      const body = adfToText(j.fields?.description);
      return { ref, title: `${ref.ref} ${j.fields?.summary ?? ""}`.trim(), body, links: extractLinks(body) };
    }
    case "linear": {
      const t = env.trackers?.linear;
      if (!t?.apiKey) throw new Error("Linear is not set up. Connect the Linear connector, or add a Linear API key with /plugin configure baseline.");
      const r = await http("https://api.linear.app/graphql", {
        method: "POST",
        headers: { authorization: t.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ query: "query($id:String!){issue(id:$id){identifier title description}}", variables: { id: ref.ref } }),
      });
      if (!r.ok) throw new Error(`Linear returned ${r.status} for ${ref.ref}`);
      const issue = check(linearSchema, await r.json(), "Linear").data?.issue;
      if (!issue) throw new Error(`Linear has no issue ${ref.ref}`);
      const body = issue.description ?? "";
      return { ref, title: `${issue.identifier} ${issue.title}`, body, links: extractLinks(body) };
    }
    case "file": {
      const isPdf = extname(ref.ref).toLowerCase() === ".pdf";
      const body = isPdf ? "" : readFileSync(ref.ref, "utf8");
      return { ref, title: basename(ref.ref), body, links: extractLinks(body), ...(isPdf ? { files: [ref.ref] } : {}) };
    }
    case "folder": {
      const files = readdirSync(ref.ref).filter((n) => SPEC_EXT.has(extname(n).toLowerCase())).sort().map((n) => join(ref.ref, n));
      return { ref, title: basename(ref.ref), body: "", links: [], files };
    }
    case "url":
      return { ref, title: ref.ref, body: "", links: [ref.ref] };
    case "text":
      return { ref, title: ref.ref.slice(0, 60), body: ref.ref, links: extractLinks(ref.ref) };
    default: {
      const never: never = ref.kind;
      throw new Error(`unknown input kind ${String(never)}`);
    }
  }
}
