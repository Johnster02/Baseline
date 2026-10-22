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
export const patternsSchema = z.object({
  email: patternSet.default({ urls: [], words: [] }),
  auth: patternSet.default({ urls: [], words: [] }),
  delete: patternSet.default({ urls: [], words: [] }),
  finance: patternSet.default({ urls: [], words: [] }),
});
export type Patterns = z.infer<typeof patternsSchema>;

/** Sensible starting words for every site; setup lets the user add their own. */
export function defaultPatterns(): Patterns {
  return {
    email: { urls: [], words: ["send email", "send invite", "invite", "notify", "resend", "send invoice", "share via email"] },
    auth: { urls: ["**/password/**", "**/sign-up**", "**/signup**", "**/register**"], words: ["change password", "reset password", "sign up", "change role", "remove member", "revoke"] },
    delete: { urls: [], words: ["delete project", "delete user", "delete account", "remove user", "delete workspace", "deactivate"] },
    finance: { urls: ["**/billing/**", "**/checkout/pay**", "**/payments/**"], words: ["pay", "pay now", "place order", "purchase", "refund", "charge", "subscribe", "upgrade plan"] },
  };
}

export const projectConfigSchema = z.object({
  runners: z.array(runnerSchema).default([]),
  patterns: patternsSchema.default(defaultPatterns()),
  readPosts: z.array(z.string()).default([]),
  productionUrls: z.array(z.string()).default([]),
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
