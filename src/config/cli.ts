import { register, out, err, io } from "../cli";
import { CATEGORIES, DEPTHS, THEMES, projectConfigSchema } from "./schema";
import type { Category, Depth } from "./schema";
import { checkTarget, describePermissions, ensureGitignored, loadConfig, newRunner, saveConfig } from "./store";
import { dataDir, removeSecret, setSecret } from "./secrets";

const SETTABLE = ["patterns", "readPosts", "productionUrls", "lastUrl", "theme", "versionProbe", "checklistExtra"] as const;

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
      `  can: ${p.can.join("; ")}`, `  cannot: ${p.cannot.join("; ")}`].join("\n");
  }).join("\n\n");
}

register("config", "show | describe | add-runner | remove-runner | depth | allow | deny | set | secret", async (args) => {
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
      cfg.runners.push(newRunner(key, persona, kind === "form" ? { kind, loginUrl: loginUrl! } : { kind }));
      saveConfig(dir, cfg);
      ensureGitignored(dir);
      out(`added runner ${key} (look only)`);
      return 0;
    }
    case "remove-runner": {
      const before = cfg.runners.length;
      cfg.runners = cfg.runners.filter((r) => r.key !== a[0]);
      if (cfg.runners.length === before) { err(`no runner "${a[0]}"`); return 2; }
      saveConfig(dir, cfg);
      removeSecret(dataDir(), dir, a[0]!);
      out(`removed runner ${a[0]} and its saved sign-in`);
      return 0;
    }
    case "depth": {
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      if (!DEPTHS.includes(a[1] as Depth)) { err(`depth must be one of ${DEPTHS.join(", ")}`); return 2; }
      r.depth = a[1] as Depth;
      saveConfig(dir, cfg);
      out(`${r.key} depth: ${r.depth}`);
      return 0;
    }
    case "allow":
    case "deny": {
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      const c = a[1] as Category;
      if (!CATEGORIES.includes(c)) { err(`category must be one of ${CATEGORIES.join(", ")}`); return 2; }
      r.allow = sub === "allow" ? [...new Set([...r.allow, c])] : r.allow.filter((x) => x !== c);
      saveConfig(dir, cfg);
      out(`${r.key} ${sub === "allow" ? "may now" : "may no longer"}: ${c}`);
      return 0;
    }
    case "set": {
      const [field, value] = a;
      if (!SETTABLE.includes(field as (typeof SETTABLE)[number]) || value === undefined) {
        err(`usage: baseline config set <${SETTABLE.join("|")}> <json or text>`);
        return 2;
      }
      let parsed: unknown = value;
      if (/^\s*[[{]/.test(value)) {
        try { parsed = JSON.parse(value); } catch { err(`${field} must be valid JSON`); return 2; }
      }
      if (field === "theme" && !THEMES.includes(parsed as never)) { err(`theme must be one of ${THEMES.join(", ")}`); return 2; }
      const next = projectConfigSchema.safeParse({ ...cfg, [field]: parsed });
      if (!next.success) { err(next.error.issues.map((i) => i.message).join("; ")); return 2; }
      saveConfig(dir, next.data);
      out(`set ${field}`);
      return 0;
    }
    case "secret": {
      // Credentials arrive on stdin as JSON so they never sit in shell history or argv.
      const r = runnerOr(cfg, a[0]);
      if (!r) return 2;
      let creds: { username?: unknown; password?: unknown };
      try { creds = JSON.parse(io.readStdin()); } catch { err("stdin must be JSON: {\"username\":..., \"password\":...}"); return 2; }
      if (typeof creds.username !== "string" || typeof creds.password !== "string") { err("stdin must be {\"username\":..., \"password\":...}"); return 2; }
      setSecret(dataDir(), dir, r.key, { username: creds.username as string, password: creds.password as string });
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
