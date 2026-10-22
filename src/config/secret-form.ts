import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setSecret } from "./secrets";

const PAGE = (runner: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baseline sign-in details</title>
<style>body{font:15px system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px;color:#1d1d1f}label{display:block;margin:14px 0 4px}input{width:100%;padding:8px;font:inherit;box-sizing:border-box}button{margin-top:18px;padding:8px 16px;font:inherit}p{color:#555}</style></head>
<body><h1>Sign-in details for “${runner.replace(/[^a-z0-9-]/gi, "")}”</h1><p>These go straight to a private file on this computer. Claude never sees them.</p>
<form method="post"><label for="u">Email or username</label><input id="u" name="username" autocomplete="off" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="off" required><button type="submit">Save</button></form></body></html>`;

function defaultOpen(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); } catch { /* the URL is printed too */ }
}

/**
 * A one-time local form for a runner's password, so it never passes through the chat, a tool call
 * or shell history. Listens on 127.0.0.1 behind a random path, saves once, then closes.
 */
export function secretForm(o: { data: string; projectDir: string; runner: string; open?: (url: string) => void; timeoutMs?: number }): Promise<{ ok: boolean }> {
  const token = randomBytes(16).toString("hex");
  return new Promise((resolveP) => {
    let finished = false;
    const finish = (ok: boolean) => { if (finished) return; finished = true; server.close(); resolveP({ ok }); };
    const server = createServer(async (req, res) => {
      const path = new URL(req.url || "/", "http://x").pathname;
      if (path !== `/${token}`) { res.writeHead(404); res.end(); return; }
      if (req.method === "GET") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(PAGE(o.runner)); return; }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
      let body = "";
      for await (const c of req) { body += c; if (body.length > 10_000) { res.writeHead(413); res.end(); return; } }
      const f = new URLSearchParams(body);
      const username = f.get("username") ?? "", password = f.get("password") ?? "";
      if (!username || !password) { res.writeHead(400); res.end("Both fields are needed."); return; }
      setSecret(o.data, o.projectDir, o.runner, { username, password });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><p style='font:15px system-ui;margin:12vh auto;max-width:420px'>Saved. You can close this tab and go back to Claude Code.</p>");
      finish(true);
    });
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;
      (o.open ?? defaultOpen)(url);
      if (!o.open) process.stdout.write(`Opened a sign-in form in your browser. If it did not open, visit:\n${url}\n`);
    });
    setTimeout(() => finish(false), o.timeoutMs ?? 10 * 60 * 1000).unref();
  });
}
