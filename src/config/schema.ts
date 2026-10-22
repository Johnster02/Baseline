import { z } from "zod";

export const DEPTHS = ["look", "create", "workflow"] as const;
export const CATEGORIES = ["live", "email", "auth", "delete", "finance"] as const;
export const THEMES = ["br2049", "light", "dark"] as const;

export type Depth = (typeof DEPTHS)[number];
export type Category = (typeof CATEGORIES)[number];
export type ThemeName = (typeof THEMES)[number];
export type PatternCategory = Exclude<Category, "live">;

const auth = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("form"), loginUrl: z.string() }),
  z.object({ kind: z.literal("session") }),
]);

export const runnerSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "runner keys are lowercase letters, digits and hyphens"),
  persona: z.string().min(1),
  depth: z.enum(DEPTHS).default("look"),
  allow: z.array(z.enum(CATEGORIES)).default([]),
  auth,
});
export type Runner = z.infer<typeof runnerSchema>;

const patternSet = z.object({ urls: z.array(z.string()).default([]), words: z.array(z.string()).default([]) });
const strictPatterns = z.object({ email: patternSet, auth: patternSet, delete: patternSet, finance: patternSet });
export type Patterns = z.infer<typeof strictPatterns>;

/** User patterns are added on top of the defaults, never in place of them, so editing one
 *  category can't leave another unprotected. */
export const patternsSchema = z.preprocess((raw) => {
  const user = (raw && typeof raw === "object" ? raw : {}) as Record<string, { urls?: string[]; words?: string[] } | undefined>;
  const d = defaultPatterns();
  const merged: Record<string, { urls: string[]; words: string[] }> = {};
  for (const k of Object.keys(d) as (keyof Patterns)[]) {
    const u = user[k] || {};
    merged[k] = {
      urls: [...new Set([...d[k].urls, ...(Array.isArray(u.urls) ? u.urls : [])])],
      words: [...new Set([...d[k].words, ...(Array.isArray(u.words) ? u.words.map((w) => String(w).toLowerCase()) : [])])],
    };
  }
  return merged;
}, strictPatterns);

/** A production entry: a bare host gets https:// added; anything that won't parse as an http(s) URL is rejected. */
const productionUrl = z.string().transform((v, ctx) => {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || /\s/.test(v)) throw new Error();
    return u.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: `"${v}" is not a URL` });
    return z.NEVER;
  }
});

/** Sensible starting words for every site; setup lets the user add their own. */
export function defaultPatterns(): Patterns {
  return {
    email: { urls: [], words: ["send email", "send invite", "invite", "notify", "resend", "send invoice", "share via email"] },
    auth: { urls: ["**/password/**", "**/sign-up**", "**/signup**", "**/register**", "**/logout**", "**/log-out**", "**/signout**", "**/sign-out**", "**/invite/accept**"], words: ["change password", "reset password", "sign up", "change role", "remove member", "revoke"] },
    delete: { urls: ["**/delete", "**/delete/**", "**/destroy", "**/destroy/**"], words: ["delete project", "delete user", "delete account", "remove user", "delete workspace", "deactivate"] },
    finance: { urls: ["**/billing/**", "**/checkout/pay**", "**/payments/**"], words: ["pay", "pay now", "place order", "purchase", "refund", "charge", "subscribe", "upgrade plan"] },
  };
}

export const projectConfigSchema = z.object({
  runners: z.array(runnerSchema).default([]),
  patterns: patternsSchema,
  readPosts: z.array(z.string()).default([]),
  productionUrls: z.array(productionUrl).default([]),
  lastUrl: z.string().optional(),
  theme: z.enum(THEMES).default("br2049"),
  versionProbe: z.object({ url: z.string(), pattern: z.string() }).optional(),
  checklistExtra: z.array(z.string()).default([]),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const CATEGORY_LABEL: Record<Category, string> = {
  live: "test a live site or touch real users",
  email: "send email",
  auth: "change auth or accounts (passwords, invites, roles, sign-up)",
  delete: "delete projects or users",
  finance: "touch payments or finance",
};
