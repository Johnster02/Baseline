import type { ThemeName } from "../config/schema";

/** Colour tokens per theme. The report CSS carries the same values; the terminal uses these directly. */
export const THEMES: Record<ThemeName, Record<string, string>> = {
  br2049: {
    void: "#0e0d0a", deck: "#17160f", rule: "#34312a", ink: "#eee8d8", ink2: "#bdb5a3", ink3: "#847c6d",
    accent: "#bdeaa2", accentDim: "#5f7a52", dust: "#f0a057",
    match: "#a9cf98", conflict: "#ff6a5c", builtObs: "#f0a057", notBuilt: "#b4a5e6", guide: "#e6cf6e", unspecced: "#96c9da", product: "#e889c8", unverified: "#7d8c86", skipped: "#a59d8d",
  },
  light: {
    void: "#f4f5f4", deck: "#ffffff", rule: "#e1e4e2", ink: "#141b19", ink2: "#46524e", ink3: "#77817d",
    accent: "#14826c", accentDim: "#a6d2c7", dust: "#c0660f",
    match: "#1f9a85", conflict: "#d2354a", builtObs: "#cc6d17", notBuilt: "#6a55d4", guide: "#9c7a00", unspecced: "#1c74b3", product: "#b03a8a", unverified: "#8a948f", skipped: "#6f7874",
  },
  dark: {
    void: "#0b1220", deck: "#111a2e", rule: "#1f2b45", ink: "#e6ebf5", ink2: "#a9b4cb", ink3: "#6f7c98",
    accent: "#7aa7ff", accentDim: "#2a3f6b", dust: "#f5b25c",
    match: "#5fcf9f", conflict: "#f2777a", builtObs: "#f5b25c", notBuilt: "#a596ff", guide: "#e3cb63", unspecced: "#5fb8f0", product: "#d58be8", unverified: "#7c8aa6", skipped: "#94a09c",
  },
};

export const VERDICT_VAR: Record<string, string> = {
  match: "--v-match", "spec-built": "--v-specbuilt", "built-observed": "--v-builtobs", "not-built": "--v-notbuilt",
  "guide-spec": "--v-guide", unspecced: "--v-unspec", product: "--v-product", unverified: "--v-unverified", skipped: "--v-human",
};

export const VERDICT_LABEL: Record<string, string> = {
  match: "match", "spec-built": "spec ≠ built", "built-observed": "built ≠ observed", "not-built": "not built",
  "guide-spec": "guide ≠ spec", unspecced: "unspecced", product: "product", unverified: "unverified", skipped: "skipped",
};
