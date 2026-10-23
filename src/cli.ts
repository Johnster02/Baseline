import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import manifest from "../.claude-plugin/plugin.json";

/** Indirection so tests can supply stdin. `origCwd` is where the command was run from, before the
 *  CLI moved to the project root, so path arguments resolve the way the caller meant them. */
let orig: string | undefined;
export const io = {
  readStdin: (): string => readFileSync(0, "utf8"),
  /** Open a local file in the default browser. */
  openFile(path: string): void {
    const [cmd, args]: [string, string[]] = process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]] : ["xdg-open", [path]];
    try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* the path is printed anyway */ }
  },
  get origCwd(): string { return orig ?? process.cwd(); },
  set origCwd(v: string) { orig = v; },
};

export type Handler = (args: string[]) => Promise<number> | number;

const commands = new Map<string, { handler: Handler; help: string }>();

export function register(name: string, help: string, handler: Handler): void {
  // Two modules claiming one name would silently drop the first handler.
  if (commands.has(name)) throw new Error(`baseline: command "${name}" is registered twice`);
  commands.set(name, { handler, help });
}

export function commandNames(): string[] {
  return [...commands.keys()];
}

export function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function err(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : text + "\n");
}

register("version", "print the plugin version", () => {
  out(manifest.version);
  return 0;
});

function usage(): string {
  const lines = [...commands.entries()].sort().map(([n, c]) => `  ${n.padEnd(14)} ${c.help}`);
  return ["usage: baseline <command> [args]", "", ...lines].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const cmd = name ? commands.get(name) : undefined;
  if (!cmd) {
    err(usage());
    return 2;
  }
  return await cmd.handler(rest);
}
