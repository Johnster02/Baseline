import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretForm } from "../src/config/secret-form";
import { getSecret } from "../src/config/secrets";

describe("secret form", () => {
  it("saves what the user types in the local form, never echoing it", async () => {
    const data = mkdtempSync(join(tmpdir(), "d-")), proj = mkdtempSync(join(tmpdir(), "p-"));
    let shown = "";
    const done = secretForm({ data, projectDir: proj, runner: "customer", origin: "https://shop.acme.test", open: (u) => { shown = u; } });
    await vi.waitFor(() => { if (!shown) throw new Error("not open yet"); }, { timeout: 5000 });
    expect(shown).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/);
    expect((await fetch(shown.replace(/\/[a-f0-9]{32}$/, "/wrong"))).status).toBe(404);
    const page = await (await fetch(shown)).text();
    expect(page).toContain('type="password"');
    const r = await fetch(shown, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=c%40acme.test&password=p%27w%22%5C1" });
    expect(await r.text()).not.toContain("p'w");
    expect(await done).toEqual({ ok: true });
    expect(getSecret(data, proj, "customer")).toEqual({ username: "c@acme.test", password: "p'w\"\\1", origin: "https://shop.acme.test" });
  });
  it("refuses a post from another site and closes after one use", async () => {
    const data = mkdtempSync(join(tmpdir(), "d-")), proj = mkdtempSync(join(tmpdir(), "p-"));
    let shown = "";
    const done = secretForm({ data, projectDir: proj, runner: "customer", origin: "https://shop.acme.test", open: (u) => { shown = u; } });
    await vi.waitFor(() => { if (!shown) throw new Error("not open yet"); }, { timeout: 5000 });
    const body = "username=a&password=b";
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    expect((await fetch(shown, { method: "POST", headers: { ...headers, origin: "https://evil.tld" }, body })).status).toBe(403);
    expect(getSecret(data, proj, "customer")).toBeUndefined();
    expect((await fetch(shown, { method: "POST", headers: { ...headers, origin: new URL(shown).origin }, body })).status).toBe(200);
    expect(await done).toEqual({ ok: true });
    // Used once: the server has closed (or answers 410 on a kept-alive connection).
    const again = await fetch(shown, { method: "POST", headers, body: "username=x&password=y" }).then((r) => r.status, () => 0);
    expect(again).not.toBe(200);
    expect(getSecret(data, proj, "customer")).toEqual({ username: "a", password: "b", origin: "https://shop.acme.test" });
  });
});
