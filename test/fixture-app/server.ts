// "Acme shop": a tiny made-up site for testing Baseline's browser guard and sign-in.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FIXTURE_USER = { username: "customer@acme.test", password: "pw" };
export const FIXTURE_COMMIT = "a41c9e2";

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><nav><a href="/cart">Cart</a> <a href="/checkout">Checkout</a> <a href="/admin">Admin</a></nav><main><h1>${title}</h1>${body}</main>
<p id="status" role="status"></p>
<script>
async function call(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    document.getElementById("status").textContent = "done " + r.status;
  } catch (e) { document.getElementById("status").textContent = "failed"; }
}
</script></body></html>`;

const PAGES: Record<string, string> = {
  "/cart": page("Cart", `<ul><li>Mug x1</li></ul>
    <label>Discount code <input name="code" id="code"></label>
    <button onclick="call('/api/cart', {code: document.getElementById('code').value})">Apply discount</button>
    <label>Search <input id="q"></label> <button onclick="call('/api/search', {q: document.getElementById('q').value})">Search</button>`),
  "/checkout": page("Checkout", `<p>Total: $12.00</p><button onclick="call('/api/pay')">Pay now</button>`),
  "/admin": page("Admin", `<button onclick="call('/api/invoice/send')">Send invoice</button>
    <button onclick="call('/api/users/7/delete')">Delete user</button>
    <a href="/users/7/delete">Remove member</a> <a href="/logout">Log out</a>
    <button onclick="document.getElementById('confirm').hidden=false">Delete project</button>
    <div id="confirm" hidden role="dialog" aria-label="Are you sure?"><button onclick="fetch('/api/projects/3',{method:'DELETE'}).then(r=>document.getElementById('status').textContent='done '+r.status).catch(()=>document.getElementById('status').textContent='failed')">Confirm</button></div>
    <button title="Archive" onclick="call('/api/archive')"><svg width="10" height="10"></svg></button>`),
  "/gql": page("Profile", `<p id="me">loading</p><button onclick="gql('mutation { rename }')">Rename</button>
    <script>
    function gql(q) { return fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
      .then(r => document.getElementById('status').textContent = 'done ' + r.status).catch(() => document.getElementById('status').textContent = 'failed'); }
    gql('query { me { name } }');
    </script>`),
  "/users/7/delete": page("Removed", `<p>Member removed.</p>`),
  "/logout": page("Logged out", `<p>Bye.</p>`),
  "/tracked": page("Tracked", `<p>This page reports a view on load.</p><script>fetch('/api/track', {method: 'POST', body: '{}'})</script>`),
};

function signedIn(req: IncomingMessage) {
  return /(?:^|;\s*)sid=ok(?:;|$)/.test(req.headers.cookie || "");
}

async function readBody(req: IncomingMessage) {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

export async function startFixture(): Promise<{ url: string; requests: { method: string; path: string }[]; stop(): Promise<void> }> {
  const requests: { method: string; path: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    const method = req.method || "GET";
    requests.push({ method, path });
    const body = await readBody(req);
    const html = (s: string) => { res.writeHead(200, { "content-type": "text/html" }); res.end(s); };
    if (path === "/version") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ commit: FIXTURE_COMMIT })); return; }
    if (path === "/login" && method === "GET") {
      html(page("Sign in", `<form method="post" action="/login"><label>Email <input type="email" name="email"></label>
        <label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>`));
      return;
    }
    if (path === "/login" && method === "POST") {
      const f = new URLSearchParams(body);
      if (f.get("email") === FIXTURE_USER.username && f.get("password") === FIXTURE_USER.password) {
        res.writeHead(302, { location: "/cart", "set-cookie": "sid=ok; Path=/; HttpOnly" });
      } else {
        res.writeHead(302, { location: "/login?error=1" });
      }
      res.end();
      return;
    }
    if (path === "/" ) { res.writeHead(302, { location: "/cart" }); res.end(); return; }
    if (PAGES[path]) {
      if (!signedIn(req)) { res.writeHead(302, { location: "/login" }); res.end(); return; }
      html(PAGES[path]);
      return;
    }
    if (path === "/graphql") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":{}}'); return; }
    if (path.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    res.writeHead(404); res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((r) => server.close(() => r())) };
}
