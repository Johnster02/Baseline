// `s.fixture()` and `s.upload()`: a script builds its own test data from files shipped with the
// plugin, and may name nothing outside its run folder. The refusals are the point of this file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFixture } from "./fixture-app/server";
import { openSession as rawOpenSession, readBlocked, type Session } from "../src/browser/session";
import { trustRun } from "./helpers/trust";
import { loadConfig, newRunner } from "../src/config/store";
import { readJsonl } from "../src/core/json";

let f: Awaited<ReturnType<typeof startFixture>>;
let state: string;
/** A file well outside any run folder, for the symlink-escape tests. */
let outside: string;

beforeAll(async () => {
  // Trusted run state goes to the data folder: keep it out of the real one.
  process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "data-")));
  f = await startFixture();
  state = join(realpathSync(mkdtempSync(join(tmpdir(), "st-"))), "state.json");
  const host = new URL(f.url).hostname;
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
  outside = join(realpathSync(mkdtempSync(join(tmpdir(), "outside-"))), "secret.txt");
  writeFileSync(outside, "pretend this is a saved session\n");
});
afterAll(() => f.stop());

/** Open a session on a hand-made run folder, recording it the way `run new` would first. */
const openSession: typeof rawOpenSession = (o) => { trustRun(o); return rawOpenSession(o); };

const look = newRunner("customer", "customer", { kind: "session" });
const create = { ...look, depth: "create" as const };
const lines = (p: string) => readJsonl<Record<string, unknown>>(p);
const had = (method: string, path: string) => f.requests.some((r) => r.method === method && r.path === path);

async function withSession(runner: typeof look, fn: (s: Session, dir: string) => Promise<void>): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
  const cfg = loadConfig(dir);
  const s = await openSession({ runDir: dir, runId: "r-test", runner, cfg, baseUrl: f.url, storageState: state });
  try { await fn(s, dir); } finally { await s.close(); }
  return dir;
}

/** What the plugin ships, as `fixture` itself sees it. */
const SHIPPED = ["clip.mp4", "data.csv", "document.pdf", "image.png"];

describe("fixtures shipped with the plugin", () => {
  it("ships a small PNG, MP4, PDF and CSV, each under 200 KB", () => {
    for (const name of SHIPPED) {
      const p = resolve("fixtures", name);
      expect(existsSync(p), name).toBe(true);
      expect(statSync(p).size, name).toBeGreaterThan(0);
      expect(statSync(p).size, name).toBeLessThan(200 * 1024);
    }
  });
});

describe("s.fixture", () => {
  it("copies a fixture into the run folder and returns its relative path", async () => {
    await withSession(look, async (s, dir) => {
      const rel = await s.fixture("clip.mp4");
      expect(rel).toBe(join("fixtures", "clip.mp4"));
      const copied = join(dir, rel);
      expect(existsSync(copied)).toBe(true);
      expect(readFileSync(copied)).toEqual(readFileSync(resolve("fixtures", "clip.mp4")));
    });
  });

  it("names what is available when the fixture is unknown", async () => {
    await withSession(look, async (s) => {
      await expect(s.fixture("nope.mov")).rejects.toThrow(/clip\.mp4/);
      await expect(s.fixture("nope.mov")).rejects.toThrow(/data\.csv/);
    });
  });

  it("refuses a fixture name that is a path", async () => {
    await withSession(look, async (s) => {
      for (const name of ["../../etc/passwd", "sub/clip.mp4", "/etc/passwd", "..", ".", ""]) {
        await expect(s.fixture(name), name).rejects.toThrow(/fixture/i);
      }
    });
  });
});

describe("s.upload refusals", () => {
  it("refuses a path outside the run folder", async () => {
    await withSession(look, async (s) => {
      for (const p of ["../../etc/passwd", "/etc/passwd", "fixtures/../../x", "..", outside]) {
        await expect(s.upload({ label: "File" }, [p]), p).rejects.toThrow(/run folder/);
      }
    });
  });

  it("refuses a symlink that points out of the run folder", async () => {
    await withSession(look, async (s, dir) => {
      mkdirSync(join(dir, "fixtures"), { recursive: true });
      symlinkSync(outside, join(dir, "fixtures", "escape.txt"));
      await expect(s.upload({ label: "File" }, ["fixtures/escape.txt"])).rejects.toThrow(/run folder/);
    });
  });

  it("refuses a path that reaches out through a symlinked folder", async () => {
    await withSession(look, async (s, dir) => {
      symlinkSync(resolve(outside, ".."), join(dir, "elsewhere"));
      await expect(s.upload({ label: "File" }, ["elsewhere/secret.txt"])).rejects.toThrow(/run folder/);
    });
  });

  it("refuses before the page or the file input is touched", async () => {
    await withSession(look, async (s, dir) => {
      await s.goto("/upload");
      symlinkSync(outside, join(dir, "escape.txt"));
      await expect(s.upload({ label: "File" }, ["escape.txt"])).rejects.toThrow(/run folder/);
      // Nothing reached the input: the page still shows no file.
      expect(await s.text({ css: "#picked" })).toBe("");
      // And a refusal names no second chance: a good path in the same call is refused with it.
      const good = await s.fixture("data.csv");
      await expect(s.upload({ label: "File" }, [good, "escape.txt"])).rejects.toThrow(/run folder/);
      expect(await s.text({ css: "#picked" })).toBe("");
    });
  });

  it("refuses a missing file and a directory", async () => {
    await withSession(look, async (s, dir) => {
      mkdirSync(join(dir, "fixtures"), { recursive: true });
      await expect(s.upload({ label: "File" }, ["fixtures/absent.png"])).rejects.toThrow(/run folder/);
      await expect(s.upload({ label: "File" }, ["fixtures"])).rejects.toThrow(/file/i);
    });
  });

  it("refuses when no path is given, or a path is not a string", async () => {
    await withSession(look, async (s) => {
      await expect(s.upload({ label: "File" }, [])).rejects.toThrow(/path/i);
      await expect(s.upload({ label: "File" }, [42 as unknown as string])).rejects.toThrow(/path/i);
    });
  });
});

describe("s.upload against the fixture app", () => {
  it("uploads a fixture copied into the run folder", async () => {
    await withSession(look, async (s) => {
      await s.goto("/upload");
      const rel = await s.fixture("clip.mp4");
      await s.upload({ label: "File" }, [rel]);
      expect(await s.text()).toContain("clip.mp4");
    });
  });

  it("uploads several files at once", async () => {
    await withSession(look, async (s) => {
      await s.goto("/upload");
      const files = [await s.fixture("image.png"), await s.fixture("data.csv")];
      await s.upload({ label: "File" }, files);
      const text = await s.text();
      expect(text).toContain("image.png");
      expect(text).toContain("data.csv");
    });
  });

  it("the POST the upload leads to still goes through the guard", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, async (s) => {
      await s.goto("/upload");
      await s.upload({ label: "File" }, [await s.fixture("image.png")]);
      await s.page.getByRole("button", { name: "Attach file" }).click();
      await s.page.getByText("failed").waitFor();
    });
    // A look-only runner's write is refused by the guard, exactly as for any other control.
    expect(had("POST", "/api/attach")).toBe(false);
    expect(lines(join(dir, "blocked.jsonl"))).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/attach" }));
    expect(readBlocked(dir)).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/attach" }));
  });

  it("a create runner's upload is sent, judged by the button's words", async () => {
    f.requests.length = 0;
    const dir = await withSession(create, async (s) => {
      await s.goto("/upload");
      await s.upload({ label: "File" }, [await s.fixture("document.pdf")]);
      await s.page.getByRole("button", { name: "Attach file" }).click();
      await s.page.getByText("done 200").waitFor();
    });
    expect(had("POST", "/api/attach")).toBe(true);
    expect(lines(join(dir, "blocked.jsonl"))).toEqual([]);
  });
});
