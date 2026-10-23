/** The only commands an agent script can send. Nothing here hands out Playwright objects. */
export const COMMANDS = [
  "open", "goto", "click", "fill", "press", "select", "check", "hover", "back", "waitFor",
  "snapshot", "text", "url", "title", "shot", "created", "close",
] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (m: unknown): m is Command => typeof m === "string" && (COMMANDS as readonly string[]).includes(m);

/** A message from a script (or relayed to the host). `method` is checked separately so the reply can name it. */
export type RpcRequest = { id: number; method: unknown; args: unknown[] };
export type RpcReply = { id: number; ok: boolean; value?: unknown; error?: string };

/** The shape check every side runs on an incoming message. Undefined: not a request at all. */
export function parseRequest(m: unknown): RpcRequest | undefined {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isFinite(o.id)) return undefined;
  if (o.args !== undefined && !Array.isArray(o.args)) return undefined;
  return { id: o.id, method: o.method, args: (o.args as unknown[] | undefined) ?? [] };
}

/** Same for replies coming back. */
export function parseReply(m: unknown): RpcReply | undefined {
  if (!m || typeof m !== "object") return undefined;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "number" || typeof o.ok !== "boolean") return undefined;
  return { id: o.id, ok: o.ok, value: o.value, ...(typeof o.error === "string" ? { error: o.error } : {}) };
}
