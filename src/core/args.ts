// One argument parser for every command, so `--run` and friends behave the same everywhere.
import { parseArgs } from "node:util";

export type FlagSpec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

/**
 * Parse `args` against `flags`. Not strict: unknown flags land in `values` instead of throwing
 * (agents sometimes pass extras; commands decide), and `--run` is always accepted.
 */
export function parseFlags<F extends FlagSpec>(args: string[], flags: F) {
  const options = { run: { type: "string" as const }, ...flags };
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true, strict: false });
  return { values: values as { [K in keyof F | "run"]?: K extends keyof F ? (F[K]["type"] extends "boolean" ? boolean : string) : string }, positionals };
}

/** Type guard for a value from a fixed list. */
export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}
