// Turns a script's request into a call on the runner's Session. Shared by the browser host
// (one browser for the whole run) and `baseline script`'s fallback (a browser of its own), so
// both behave the same; they differ only in what `close` does.
import type { Session, Target } from "./session";
import { isCommand } from "./rpc";
import type { Command, RpcReply, RpcRequest } from "./rpc";
import { errMsg } from "../core/json";

/** No agent wait may hang a runner's browser: Playwright's `timeout: 0` means forever. */
export const MAX_WAIT_MS = 60_000;
const clampWait = (opts: unknown): { state?: "visible" | "hidden"; timeout?: number } | undefined => {
  if (!opts || typeof opts !== "object") return undefined;
  const o = opts as { state?: "visible" | "hidden"; timeout?: unknown };
  const t = typeof o.timeout === "number" && o.timeout > 0 ? Math.min(o.timeout, MAX_WAIT_MS) : o.timeout === undefined ? undefined : MAX_WAIT_MS;
  return { ...(o.state ? { state: o.state } : {}), ...(t === undefined ? {} : { timeout: t }) };
};

type Callable = Exclude<Command, "open" | "close">;
const T = (a: unknown) => a as Target;
const S = (a: unknown) => a as string;
/** Every command a script may call, mapped to the Session method. Arguments are checked by Playwright. */
const handlers: { [K in Callable]: (s: Session, a: unknown[]) => unknown } = {
  goto: (s, a) => s.goto(S(a[0])),
  click: (s, a) => s.click(T(a[0])),
  fill: (s, a) => s.fill(T(a[0]), S(a[1])),
  press: (s, a) => s.press(S(a[0]), a[1] === undefined ? undefined : T(a[1])),
  select: (s, a) => s.select(T(a[0]), S(a[1])),
  check: (s, a) => s.check(T(a[0])),
  hover: (s, a) => s.hover(T(a[0])),
  back: (s) => s.back(),
  waitFor: (s, a) => s.waitFor(T(a[0]), clampWait(a[1])),
  snapshot: (s) => s.snapshot(),
  text: (s, a) => s.text(a[0] === undefined ? undefined : T(a[0])),
  url: (s) => s.url(),
  title: (s) => s.title(),
  shot: (s, a) => s.shot(S(a[0]), S(a[1])),
  created: (s, a) => s.created(S(a[0]), S(a[1]), a[2] === undefined ? undefined : S(a[2])),
};

export type DispatcherOptions = {
  openSession: () => Promise<Session>;
  info: { runner: string; persona: string; depth: string };
  /** Host: a script finishing is not the run finishing, so close keeps the browser. */
  keepOnClose: boolean;
  onSignedOut?: (message: string) => void;
};

export function createDispatcher(o: DispatcherOptions) {
  let session: Session | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  async function run(m: RpcRequest): Promise<Omit<RpcReply, "id">> {
    if (!isCommand(m.method)) return { ok: false, error: `"${String(m.method)}" is not an allowed command` };
    try {
      if (m.method === "open") {
        session ??= await o.openSession();
        return { ok: true, value: o.info };
      }
      if (!session) return { ok: false, error: "call open() first" };
      if (m.method === "close") {
        if (!o.keepOnClose) { const s = session; session = undefined; await s.close(); }
        return { ok: true };
      }
      return { ok: true, value: await handlers[m.method](session, m.args) };
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      if (name === "SignedOutError") o.onSignedOut?.(errMsg(e));
      return { ok: false, error: `${name}: ${errMsg(e).split("\n")[0]}` };
    }
  }

  return {
    /** One command at a time, in order: the page is shared state. */
    handle(m: RpcRequest): Promise<RpcReply> {
      const p = chain.then(() => run(m)).then((r) => ({ id: m.id, ...r }));
      chain = p.catch(() => {});
      return p;
    },
    /** Wait for queued commands (bounded by the caller), then close the browser. */
    async close(): Promise<void> {
      await chain.catch(() => {});
      const s = session;
      session = undefined;
      if (s) await s.close().catch(() => {});
    },
    get idle(): Promise<unknown> { return chain; },
  };
}
