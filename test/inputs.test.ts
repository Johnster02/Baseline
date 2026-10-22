import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInputs } from "../src/inputs/resolve";
import { fetchInput } from "../src/inputs/fetch";
import { adfToText } from "../src/inputs/jira";

const ctx = (jira = false, linear = false, cwd = mkdtempSync(join(tmpdir(), "in-"))) => ({ trackers: { jira, linear }, cwd });

describe("resolveInputs", () => {
  it("maps each form to its kind", () => {
    const c = ctx(true, false);
    expect(resolveInputs(["https://github.com/acme/shop/pull/412"], c)).toEqual([{ kind: "github-pr", ref: "https://github.com/acme/shop/pull/412" }]);
    expect(resolveInputs(["https://github.com/acme/shop/issues/9"], c)).toEqual([{ kind: "github-issue", ref: "https://github.com/acme/shop/issues/9" }]);
    expect(resolveInputs(["#412"], c)).toEqual([{ kind: "github-pr", ref: "412" }]);
    expect(resolveInputs(["412"], c)).toEqual([{ kind: "github-pr", ref: "412" }]);
    expect(resolveInputs(["https://acme.atlassian.net/browse/SHOP-12"], c)).toEqual([{ kind: "jira", ref: "SHOP-12" }]);
    expect(resolveInputs(["https://linear.app/acme/issue/ENG-7/discounts"], c)).toEqual([{ kind: "linear", ref: "ENG-7" }]);
    expect(resolveInputs(["https://docs.acme.dev/spec"], c)).toEqual([{ kind: "url", ref: "https://docs.acme.dev/spec" }]);
    expect(resolveInputs(["Expired codes are rejected at checkout"], c)).toEqual([{ kind: "text", ref: "Expired codes are rejected at checkout" }]);
  });

  it("a bare key goes to the one configured tracker", () => {
    expect(resolveInputs(["ENG-7"], ctx(false, true))).toEqual([{ kind: "linear", ref: "ENG-7" }]);
    expect(resolveInputs(["ENG-7"], ctx(true, false))).toEqual([{ kind: "jira", ref: "ENG-7" }]);
  });

  it("a bare key with both trackers is ambiguous, never guessed", () => {
    expect(resolveInputs(["ABC-12"], ctx(true, true))).toEqual({ ambiguous: "ABC-12", options: ["jira", "linear"] });
  });

  it("a bare key with no tracker is ambiguous too", () => {
    expect(resolveInputs(["ABC-12"], ctx(false, false))).toEqual({ ambiguous: "ABC-12", options: ["jira", "linear"] });
  });

  it("existing paths become file or folder", () => {
    const c = ctx();
    writeFileSync(join(c.cwd, "spec.md"), "# Spec");
    mkdirSync(join(c.cwd, "docs"));
    expect(resolveInputs(["spec.md", "docs"], c)).toEqual([{ kind: "file", ref: join(c.cwd, "spec.md") }, { kind: "folder", ref: join(c.cwd, "docs") }]);
  });
});

describe("fetchInput", () => {
  it("GitHub PR returns changed files and head sha via gh", async () => {
    const exec = async (cmd: string, args: string[]) => {
      expect(cmd).toBe("gh");
      expect(args.slice(0, 3)).toEqual(["pr", "view", "412"]);
      return JSON.stringify({ title: "Discount codes", body: "See https://acme.notion.so/spec", files: [{ path: "src/cart.ts" }, { path: "src/discount.ts" }], headRefOid: "b7c1d2e" });
    };
    const r = await fetchInput({ kind: "github-pr", ref: "412" }, { exec });
    expect(r).toMatchObject({ title: "Discount codes", changedFiles: ["src/cart.ts", "src/discount.ts"], headSha: "b7c1d2e" });
    expect(r.links).toEqual(["https://acme.notion.so/spec"]);
  });

  it("a number that is not a PR falls back to the issue", async () => {
    const exec = async (_c: string, args: string[]) => {
      if (args[0] === "pr") throw new Error("no pull requests found");
      return JSON.stringify({ title: "Bug: expired codes", body: "steps" });
    };
    const r = await fetchInput({ kind: "github-pr", ref: "9" }, { exec });
    expect(r.ref.kind).toBe("github-issue");
    expect(r.title).toBe("Bug: expired codes");
  });

  it("Jira uses REST v3 with basic auth and renders the description", async () => {
    const http = async (url: string, init: RequestInit) => {
      expect(url).toBe("https://acme.atlassian.net/rest/api/3/issue/SHOP-12?fields=summary,description");
      expect((init.headers as Record<string, string>).authorization).toBe("Basic " + Buffer.from("qa@acme.test:tok").toString("base64"));
      return { ok: true, status: 200, json: async () => ({ fields: { summary: "Discounts", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Expired codes are rejected." }] }] } } }) };
    };
    const r = await fetchInput({ kind: "jira", ref: "SHOP-12" }, { http, trackers: { jira: { baseUrl: "https://acme.atlassian.net", email: "qa@acme.test", token: "tok" } } });
    expect(r).toMatchObject({ title: "SHOP-12 Discounts", body: "Expired codes are rejected." });
  });

  it("Linear uses GraphQL with the API key", async () => {
    const http = async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.linear.app/graphql");
      expect((init.headers as Record<string, string>).authorization).toBe("lin_key");
      return { ok: true, status: 200, json: async () => ({ data: { issue: { identifier: "ENG-7", title: "Discounts", description: "Codes expire." } } }) };
    };
    const r = await fetchInput({ kind: "linear", ref: "ENG-7" }, { http, trackers: { linear: { apiKey: "lin_key" } } });
    expect(r).toMatchObject({ title: "ENG-7 Discounts", body: "Codes expire." });
  });

  it("a tracker with no token says so instead of failing silently", async () => {
    await expect(fetchInput({ kind: "jira", ref: "SHOP-1" }, {})).rejects.toThrow(/Jira is not set up/);
  });

  it("a folder lists readable spec files", async () => {
    const d = mkdtempSync(join(tmpdir(), "f-"));
    for (const n of ["a.md", "b.txt", "c.html", "d.pdf", "e.png"]) writeFileSync(join(d, n), "x");
    const r = await fetchInput({ kind: "folder", ref: d }, {});
    expect(r.files?.map((p) => p.split("/").pop())).toEqual(["a.md", "b.txt", "c.html", "d.pdf"]);
  });
});

describe("adfToText", () => {
  it("joins paragraphs and list items", () => {
    expect(adfToText({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "One" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Two" }] }] }] },
    ] })).toBe("One\n- Two");
  });
});
