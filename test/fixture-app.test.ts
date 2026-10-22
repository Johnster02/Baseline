import { describe, it, expect, afterAll } from "vitest";
import { startFixture } from "./fixture-app/server";

describe("Acme shop fixture", async () => {
  const f = await startFixture();
  afterAll(() => f.stop());

  it("serves the deployed commit at /version", async () => {
    const r = await fetch(f.url + "/version");
    expect(await r.json()).toEqual({ commit: "a41c9e2" });
  });

  it("records method and path of every request", async () => {
    await fetch(f.url + "/api/cart", { method: "POST", body: "{}" });
    expect(f.requests).toContainEqual({ method: "POST", path: "/api/cart" });
  });

  it("protects /cart behind sign-in", async () => {
    const r = await fetch(f.url + "/cart", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
  });
});
