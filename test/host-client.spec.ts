// The script side of the browser host, in-process against a fake host on a Unix socket.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHost, hostKey, isHostProcess, stopHosts } from "../src/browser/host";

const TOKEN = "t0k3n";
let data: string, runDir: string, servers: Server[];
const hosts = () => join(data, "hosts");
const writeInfo = (key: string, info: object) => { mkdirSync(hosts(), { recursive: true }); writeFileSync(join(hosts(), `${key}.json`), JSON.stringify(info)); };

/** A fake host: answers ping, echoes `url`, never answers `hang`, refuses a wrong token. */
async function fakeHost(): Promise<string> {
  const sock = join(mkdtempSync(join(tmpdir(), "hc-")), "h.sock");
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as { id: number; method: string; token: string };
        buf = buf.slice(nl + 1);
        if (m.token !== TOKEN) { c.destroy(); return; }
        if (m.method === "hang") continue;
        if (m.method === "drop") { c.destroy(); return; }
        if (m.method === "garbage") { c.write("not json\n"); continue; }
        c.write(JSON.stringify({ id: m.id, ok: true, value: m.method === "url" ? "http://x/cart" : "pong" }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  servers.push(server);
  return sock;
}

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "hc-data-"));
  process.env.BASELINE_DATA = data;
  runDir = join(mkdtempSync(join(tmpdir(), "hc-run-")), "r-1");
  mkdirSync(runDir, { recursive: true });
  servers = [];
});
afterEach(async () => {
  delete process.env.BASELINE_SHARED_BROWSER;
  delete process.env.BASELINE_HOST_TIMEOUT_MS;
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe("isHostProcess", () => {
  it("is false for a dead PID and for a live process that isn't a browser host", () => {
    expect(isHostProcess(2 ** 22 + 12345)).toBe(false);
    expect(isHostProcess(process.pid)).toBe(false);
  });
});

describe("stopHosts", () => {
  it("returns 0 when there is no hosts folder", () => {
    expect(stopHosts(runDir)).toBe(0);
  });
  it("forgets corrupt and dead hosts without signalling anyone, and leaves other runs alone", () => {
    writeInfo("0000000000000001", { nope: true });
    writeInfo("0000000000000002", { token: "x", socket: join(tmpdir(), "gone.sock"), pid: process.pid, runDir }); // our PID: alive, not a host
    writeInfo("0000000000000003", { token: "x", socket: "s", pid: process.pid, runDir: join(tmpdir(), "other-run") });
    expect(stopHosts(runDir)).toBe(0);
    expect(existsSync(join(hosts(), "0000000000000001.json"))).toBe(false);
    expect(existsSync(join(hosts(), "0000000000000002.json"))).toBe(false);
    expect(existsSync(join(hosts(), "0000000000000003.json"))).toBe(true);
  });
});

describe("connectHost", () => {
  it("is off when BASELINE_SHARED_BROWSER=0", async () => {
    process.env.BASELINE_SHARED_BROWSER = "0";
    expect(await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs")).toBeUndefined();
  });
  it("gives up (so the script opens its own browser) when no host answers and it can't start one", async () => {
    writeInfo(hostKey(runDir, "customer"), { token: TOKEN, socket: join(tmpdir(), "nobody-home.sock"), pid: process.pid, runDir });
    expect(await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs")).toBeUndefined();
    expect(existsSync(join(hosts(), `${hostKey(runDir, "customer")}.json`))).toBe(false);
  });
  it("ignores a live host that belongs to another run", async () => {
    const socket = await fakeHost();
    writeInfo(hostKey(runDir, "customer"), { token: TOKEN, socket, pid: process.pid, runDir: join(tmpdir(), "another") });
    expect(await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs")).toBeUndefined();
  });
  it("reuses a live host over one connection, matching replies by id", async () => {
    const socket = await fakeHost();
    writeInfo(hostKey(runDir, "customer"), { token: TOKEN, socket, pid: process.pid, runDir });
    const conn = await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs");
    expect(conn).toBeDefined();
    const [a, b] = await Promise.all([conn!.call({ id: 1, method: "url" }), conn!.call({ id: 2, method: "title" })]);
    expect(a).toMatchObject({ id: 1, ok: true, value: "http://x/cart" });
    expect(b).toMatchObject({ id: 2, ok: true, value: "pong" });
    conn!.close();
  });
  it("times out a call the host never answers, and skips lines it can't read", async () => {
    process.env.BASELINE_HOST_TIMEOUT_MS = "200";
    const socket = await fakeHost();
    writeInfo(hostKey(runDir, "customer"), { token: TOKEN, socket, pid: process.pid, runDir });
    const conn = (await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs"))!;
    await expect(conn.call({ id: 1, method: "hang" })).rejects.toThrow(/timed out/);
    await expect(conn.call({ id: 2, method: "garbage" })).rejects.toThrow(/timed out/);
    conn.close();
  });
  it("fails pending calls when the host drops the connection", async () => {
    const socket = await fakeHost();
    writeInfo(hostKey(runDir, "customer"), { token: TOKEN, socket, pid: process.pid, runDir });
    const conn = (await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs"))!;
    await expect(conn.call({ id: 1, method: "drop" })).rejects.toThrow(/closed|ECONNRESET|EPIPE/);
    conn.close();
  });
  it("a call made right after close() isn't failed by the old connection closing", async () => {
    const socket = await fakeHost();
    writeInfo(hostKey(runDir, "customer"), { token: TOKEN, socket, pid: process.pid, runDir });
    const conn = (await connectHost(tmpdir(), runDir, "customer", "/nonexistent/cli.cjs"))!;
    await conn.call({ id: 1, method: "url" });
    conn.close();
    // The old socket's late "close" event must not reject this call on the new socket.
    await expect(conn.call({ id: 2, method: "url" })).resolves.toMatchObject({ id: 2, ok: true });
    conn.close();
  });
});
