import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretForm } from "../src/config/secret-form";
import { getSecret } from "../src/config/secrets";

describe("secret form", () => {
  it("saves what the user types in the local form, never echoing it", async () => {
    const data = mkdtempSync(join(tmpdir(), "d-")), proj = mkdtempSync(join(tmpdir(), "p-"));
    let shown = "";
    const done = secretForm({ data, projectDir: proj, runner: "customer", open: (u) => { shown = u; } });
    for (let i = 0; i < 50 && !shown; i++) await new Promise((r) => setTimeout(r, 20));
    expect(shown).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/);
    expect((await fetch(shown.replace(/\/[a-f0-9]{32}$/, "/wrong"))).status).toBe(404);
    const page = await (await fetch(shown)).text();
    expect(page).toContain('type="password"');
    const r = await fetch(shown, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "username=c%40acme.test&password=p%27w%22%5C1" });
    expect(await r.text()).not.toContain("p'w");
    expect(await done).toEqual({ ok: true });
    expect(getSecret(data, proj, "customer")).toEqual({ username: "c@acme.test", password: "p'w\"\\1" });
  });
});
