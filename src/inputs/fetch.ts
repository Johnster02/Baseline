import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { InputRef } from "./resolve";
import { adfToText } from "./jira";

export type Fetched = { ref: InputRef; title: string; body: string; links: string[]; changedFiles?: string[]; headSha?: string; files?: string[] };
type HttpResponse = { ok: boolean; status: number; json(): Promise<any> };
export type Trackers = { jira?: { baseUrl: string; email: string; token: string }; linear?: { apiKey: string } };
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
  const http = env.http ?? ((url, init) => fetch(url, init));
  switch (ref.kind) {
    case "github-pr": {
      try {
        const j = JSON.parse(await exec("gh", ["pr", "view", ref.ref, "--json", "title,body,files,headRefOid"]));
        return { ref, title: j.title, body: j.body ?? "", links: extractLinks(j.body ?? ""), changedFiles: (j.files ?? []).map((f: { path: string }) => f.path), headSha: j.headRefOid };
      } catch (e) {
        if (/^\d+$/.test(ref.ref)) return fetchInput({ kind: "github-issue", ref: ref.ref }, env);
        throw e;
      }
    }
    case "github-issue": {
      const j = JSON.parse(await exec("gh", ["issue", "view", ref.ref, "--json", "title,body"]));
      return { ref, title: j.title, body: j.body ?? "", links: extractLinks(j.body ?? "") };
    }
    case "jira": {
      const t = env.trackers?.jira;
      if (!t?.baseUrl || !t.token) throw new Error("Jira is not set up. Connect the Jira connector, or add the Jira URL, email and token with /plugin configure baseline.");
      const r = await http(`${t.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(ref.ref)}?fields=summary,description`, {
        headers: { authorization: "Basic " + Buffer.from(`${t.email}:${t.token}`).toString("base64"), accept: "application/json" },
      });
      if (!r.ok) throw new Error(`Jira returned ${r.status} for ${ref.ref}`);
      const j = await r.json();
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
      const issue = (await r.json()).data?.issue;
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
  }
}
