// What agent scripts get from require("baseline"). The browser and the safety guard live in the
// parent `baseline script` process; this side can only send the commands listed in rpc.ts.
import { COMMANDS } from "./rpc";

type Reply = { id: number; ok: boolean; value?: unknown; error?: string };

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call(method: string, ...args: unknown[]): Promise<unknown> {
  if (!process.send) return Promise.reject(new Error("Run this through `baseline script <runner> <file>`."));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send!({ id, method, args });
  });
}

process.on("message", (m: Reply) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(new Error(m.error));
});

export async function open() {
  const info = (await call("open")) as { runner: string; persona: string; depth: string };
  const api: Record<string, unknown> = { runner: info.runner, persona: info.persona, depth: info.depth };
  for (const c of COMMANDS) if (c !== "open") api[c] = (...a: unknown[]) => call(c, ...a);
  // Escape hatch only for naming a command dynamically; the parent still refuses anything unlisted.
  api.call = (method: string, ...a: unknown[]) => call(method, ...a);
  api.close = async () => {
    await call("close");
    process.disconnect?.();
  };
  return api;
}
