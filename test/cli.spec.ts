import { describe, it, expect, vi } from "vitest";
import { main } from "../src/cli";

function capture() {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out.push(String(s)); return true; });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out.push(String(s)); return true; });
  return { text: () => out.join(""), restore: () => { spy.mockRestore(); spyErr.mockRestore(); } };
}

describe("cli", () => {
  it("prints the manifest version", async () => {
    const c = capture();
    const code = await main(["version"]);
    c.restore();
    expect(code).toBe(0);
    expect(c.text().trim()).toBe("0.1.0");
  });

  it("returns 2 and prints usage for an unknown subcommand", async () => {
    const c = capture();
    const code = await main(["nope"]);
    c.restore();
    expect(code).toBe(2);
    expect(c.text()).toMatch(/usage: baseline/i);
  });
});
