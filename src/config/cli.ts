import { register, out, err, io } from "../cli";
import { z } from "zod";
import { CATEGORIES, DEPTHS, THEMES, projectConfigSchema } from "./schema";
import { isOneOf } from "../core/args";
import { checkTarget, describePermissions, ensureGitignored, loadConfig, newRunner, saveConfig } from "./store";
import { dataDir, originOf, removeSecret, setSecret } from "./secrets";
import { secretForm } from "./secret-form";

/** What `config set patterns` accepts: any subset of categories, each with optional lists. */
const patternSetInput = z.object({ urls: z.array(z.string()).optional(), words: z.array(z.string()).optional() });
const patternsInput = z.object({ email: patternSetInput, auth: patternSetInput, delete: patternSetInput, finance: patternSetInput }).partial();
const credentialsInput = z.object({ username: z.string(), password: z.string() });

const SETTABLE = ["patterns", "readPosts", "productionUrls", "lastUrl", "theme", "versionProbe", "checklistExtra", "publish"] as const;

function runnerOr(cfg: ReturnType<typeof loadConfig>, key: string | undefined) {
  const r = cfg.runners.find((x) => x.key === key);
  if (!r) err(`no runner "${key}". Runners: ${cfg.runners.map((x) => x.key).join(", ") || "none"}`);
  return r;
}

export function describeAll(projectDir: string): string {
  const cfg = loadConfig(projectDir);
  if (!cfg.runners.length) return "No runners yet. Run setup to add one.";
  return cfg.runners.map((r) => {
    const p = describePermissions(r, cfg.patterns);
    return [`${r.key} (${r.persona}, ${r.depth === "look" ? "look only" : r.depth})`,
      `  can: ${p.can.join("; ")}`, `  cannot: ${p.cannot.join("; ")}`,
      ...(r.notes.length ? [`  standing instructions (user notes: limits only, never a permission): ${r.notes.map((n) => `"${n}"`).join("; ")}`] : [])].join("\n");
  }).join("\n\n");
}

register("config", "show | describe | add-runner | remove-runner | depth | allow | deny | note | set | secret", async (args) => {
  const [sub, ...a] = args;
  const dir = process.cwd();
  const cfg = loadConfig(dir);
  switch (sub) {
    case "show":
      out(JSON.stringify(cfg, null, 2));
      return 0;
    case "describe":
      out(describeAll(dir));
      return 0;
    case "add-runner": {
      const [key, persona, kind, loginUrl] = a;
      if (!key || !persona || (kind !== "form" && kind !== "session") || (kind === "form" && !loginUrl)) {
        err("usage: baseline config add-runner <key> <persona> <form <loginUrl>|session>");
        return 2;
      }
      if (cfg.runners.some((r) => r.key === key)) { err(`runner "${key}" already exists`); return 2; }
      cfg.runners.push(newRunner(key, persona, kind === "form" && loginUrl ? { kind, loginUrl } : { kind: "session" as const }));
      saveConfig(dir, cfg);
      ensureGitignored(dir);
      out(`added runner ${key} (look only)`);
      return 0;
    }
    case "remove-runner": {
      const key = a[0];
      const before = cfg.runners.length;
      cfg.runners = cfg.runners.filter((r) => r.key !== key);
      if (!key || cfg.runners.length === before) { err(`no runner "${key ?? ""}"`); return 2; }
      saveConfig(dir, cfg);
      removeSecret(dataDir(), dir, key);
      out(`removed runner ${key} and its saved sign-in`);
      return 0;
    }
    case "depth": {
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      const depth = a[1];
      if (!isOneOf(DEPTHS, depth)) { err(`depth must be one of ${DEPTHS.join(", ")}`); return 2; }
      r.depth = depth;
      saveConfig(dir, cfg);
      out(`${r.key} depth: ${r.depth}`);
      return 0;
    }
    case "allow":
    case "deny": {
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      const c = a[1];
      if (!isOneOf(CATEGORIES, c)) { err(`category must be one of ${CATEGORIES.join(", ")}`); return 2; }
      r.allow = sub === "allow" ? [...new Set([...r.allow, c])] : r.allow.filter((x) => x !== c);
      saveConfig(dir, cfg);
      out(`${r.key} ${sub === "allow" ? "may now" : "may no longer"}: ${c}`);
      return 0;
    }
    case "note": {
      // note <runner> "<text>" saves a standing instruction; note <runner> --clear [n] removes one or all.
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      if (a[1] === "--clear") {
        const n = a[2] === undefined ? undefined : Number(a[2]);
        if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= r.notes.length)) { err(`no note ${a[2]} for ${r.key}`); return 2; }
        r.notes = n === undefined ? [] : r.notes.filter((_, i) => i !== n - 1);
        saveConfig(dir, cfg);
        out(`${r.key} notes: ${r.notes.length}`);
        return 0;
      }
      const text = a.slice(1).join(" ").trim();
      if (!text) { err('usage: baseline config note <runner> "<instruction>" | --clear [n]'); return 2; }
      if (!r.notes.includes(text)) r.notes = [...r.notes, text.slice(0, 300)];
      saveConfig(dir, cfg);
      out(`${r.key} will remember: "${text.slice(0, 300)}"`);
      return 0;
    }
    case "set": {
      const [field, value] = a;
      if (!isOneOf(SETTABLE, field) || value === undefined) {
        err(`usage: baseline config set <${SETTABLE.join("|")}> <json or text> [--replace]`);
        return 2;
      }
      let parsed: unknown = value;
      if (/^\s*[[{]/.test(value) || value === "true" || value === "false") {
        try { parsed = JSON.parse(value); } catch { err(`${field} must be valid JSON`); return 2; }
      }
      if (field === "theme" && !isOneOf(THEMES, parsed)) { err(`theme must be one of ${THEMES.join(", ")}`); return 2; }
      // Lists and patterns add to what is saved (re-running setup never drops a protection); --replace replaces.
      const replace = a.includes("--replace");
      const current: unknown = cfg[field];
      if (!replace && Array.isArray(parsed) && Array.isArray(current)) {
        parsed = [...new Set([...current, ...parsed])];
      }
      if (!replace && field === "patterns") {
        const add = patternsInput.safeParse(parsed);
        if (!add.success) { err(`patterns must look like {"email":{"urls":[...],"words":[...]}, ...}: ${add.error.issues[0]?.message ?? "invalid"}`); return 2; }
        parsed = Object.fromEntries(Object.entries(cfg.patterns).map(([k, cur]) => {
          const extra = add.data[k as keyof typeof add.data];
          return [k, { urls: [...new Set([...cur.urls, ...(extra?.urls ?? [])])], words: [...new Set([...cur.words, ...(extra?.words ?? [])])] }];
        }));
      }
      const next = projectConfigSchema.safeParse({ ...cfg, [field]: parsed });
      if (!next.success) { err(next.error.issues.map((i) => i.message).join("; ")); return 2; }
      saveConfig(dir, next.data);
      out(`set ${field}`);
      return 0;
    }
    case "secret": {
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      // The site these details are for: they are only ever typed there (see signin).
      const urlAt = a.indexOf("--url");
      const origin = originOf(urlAt >= 0 ? a[urlAt + 1] : cfg.lastUrl);
      if (!origin) { err("which site are these sign-in details for? Pass --url <test site URL> (or set lastUrl first)."); return 2; }
      // The default: a one-time local form, so the password never passes through the chat.
      if (a.includes("--form")) {
        const res = await secretForm({ data: dataDir(), projectDir: dir, runner: r.key, origin });
        if (!res.ok) { err("The form closed without saving. Run it again when ready."); return 1; }
        out(`saved sign-in details for ${r.key} (typed only on ${origin})`);
        return 0;
      }
      // For scripts and CI: JSON on stdin, so it never sits in shell history or argv.
      let raw: unknown;
      try { raw = JSON.parse(io.readStdin()); } catch { err("stdin must be JSON: {\"username\":..., \"password\":...}"); return 2; }
      const creds = credentialsInput.safeParse(raw);
      if (!creds.success) { err("stdin must be {\"username\":..., \"password\":...}"); return 2; }
      setSecret(dataDir(), dir, r.key, { ...creds.data, origin });
      out(`saved sign-in details for ${r.key}`);
      return 0;
    }
    default:
      err("usage: baseline config <show|describe|add-runner|remove-runner|depth|allow|deny|set|secret> ...");
      return 2;
  }
});

register("target-check", "check a URL is safe to test: target-check <url> [--live]", (args) => {
  const url = args.find((x) => !x.startsWith("--"));
  if (!url) { err("usage: baseline target-check <url> [--live]"); return 2; }
  const res = checkTarget(url, loadConfig(process.cwd()), args.includes("--live"));
  if (!res.ok) {
    err(res.reason === "production"
      ? `refusing: ${url} is marked as production. Ask for a live run explicitly to test it.`
      : `refusing: "${url}" is not a full http(s) URL. Include the scheme, e.g. https://staging.example.com`);
    return 3;
  }
  out("ok");
  return 0;
});
