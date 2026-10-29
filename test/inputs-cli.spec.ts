import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { loadTrackers, storeTrackersFromEnv } from "../src/inputs/trackers";
import { inputsFileSchema } from "../src/run/schemas";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "icli-")));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "data-")));
});
afterEach(() => vi.restoreAllMocks());

describe("trackers store", () => {
  it("saves plugin options from the hook env at 0600 and loads them", () => {
    storeTrackersFromEnv({ CLAUDE_PLUGIN_OPTION_JIRA_BASE_URL: "https://acme.atlassian.net", CLAUDE_PLUGIN_OPTION_JIRA_EMAIL: "qa@acme.test", CLAUDE_PLUGIN_OPTION_JIRA_TOKEN: "tok", CLAUDE_PLUGIN_OPTION_LINEAR_API_KEY: "" });
    const t = loadTrackers();
    expect(t.jira).toEqual({ baseUrl: "https://acme.atlassian.net", email: "qa@acme.test", token: "tok" });
    expect(t.linear).toBeUndefined();
    expect(statSync(join(process.env.BASELINE_DATA!, "trackers.json")).mode & 0o777).toBe(0o600);
  });
});

describe("baseline inputs", () => {
  it("writes inputs.json for a text and a file input", async () => {
    writeFileSync(join(cwd, "spec.md"), "Expired codes are rejected. See https://acme.notion.so/x");
    const run = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
    expect(await main(["inputs", "--run", run, "spec.md", "Check the discount field"])).toBe(0);
    const j = JSON.parse(readFileSync(join(run, "inputs.json"), "utf8"));
    expect(j.items.map((i: any) => i.ref.kind)).toEqual(["file", "text"]);
    expect(j.items[0].links).toEqual(["https://acme.notion.so/x"]);
    expect(j.unreadLinks).toEqual([]);
  });

  it("exits 4 with the options when a key is ambiguous", async () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
    expect(await main(["inputs", "--run", run, "ABC-12"])).toBe(4);
    expect(JSON.parse(out)).toEqual({ ambiguous: "ABC-12", options: ["jira", "linear"] });
  });

  it("--as forces a kind for an ambiguous key", async () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
    expect(await main(["inputs", "--run", run, "--as", "linear", "ABC-12"])).toBe(1);
    expect(out).toMatch(/Linear is not set up/);
  });
});

describe("baseline inputs --as", () => {
  it("applies to every ambiguous key instead of crashing", async () => {
    const run = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
    const code = await main(["inputs", "--run", run, "--as", "linear", "ABC-1", "DEF-2"]);
    expect(code).toBe(1);
    expect(out).toMatch(/Linear is not set up/);
  });
});

describe("links the gatherer could not read", () => {
  const runDir = () => {
    const d = join(cwd, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(d, { recursive: true });
    return d;
  };
  const write = (d: string, unreadLinks: unknown) =>
    writeFileSync(join(d, "inputs.json"), JSON.stringify({ items: [{ ref: { kind: "text", ref: "t" } }], unreadLinks }));

  it("reads the object form the gatherer actually writes", () => {
    const parsed = inputsFileSchema.parse({ items: [], unreadLinks: [{ url: "https://wiki/x", reason: "403" }] });
    expect(parsed.unreadLinks).toEqual([{ url: "https://wiki/x", reason: "403" }]);
  });

  it("still reads the old plain-string form", () => {
    const parsed = inputsFileSchema.parse({ items: [], unreadLinks: ["https://wiki/x"] });
    expect(parsed.unreadLinks).toEqual([{ url: "https://wiki/x" }]);
  });

  it("unread-link appends without disturbing the items already fetched", async () => {
    const d = runDir();
    write(d, []);
    expect(await main(["inputs", "unread-link", "https://wiki/x", "--reason", "403", "--run", d])).toBe(0);
    expect(await main(["inputs", "unread-link", "https://notion/y", "--run", d])).toBe(0);
    const f = inputsFileSchema.parse(JSON.parse(readFileSync(join(d, "inputs.json"), "utf8")));
    expect(f.items).toHaveLength(1);
    expect(f.unreadLinks).toEqual([{ url: "https://wiki/x", reason: "403" }, { url: "https://notion/y" }]);
  });

  it("refuses something that is not a URL", async () => {
    const d = runDir();
    write(d, []);
    expect(await main(["inputs", "unread-link", "not a url", "--run", d])).toBe(2);
  });

  it("size says what is actually wrong with inputs.json instead of calling it missing", async () => {
    const d = runDir();
    writeFileSync(join(d, "inputs.json"), JSON.stringify({ items: "nope", unreadLinks: [] }));
    expect(await main(["size", "--run", d, "--personas", "customer"])).toBe(2);
    expect(out).toMatch(/items/);
    expect(out).not.toMatch(/no readable inputs\.json/);
  });
});

describe("unread-link never destroys the inputs it is appending to", () => {
  const runDir = () => {
    const d = join(cwd, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(d, { recursive: true });
    return d;
  };

  it("refuses, and leaves the file alone, when inputs.json does not validate (I4)", async () => {
    const d = runDir();
    // The exact state spec 3.5 is about: a file that fails validation.
    const broken = JSON.stringify({ items: "nope", unreadLinks: [] });
    writeFileSync(join(d, "inputs.json"), broken);
    expect(await main(["inputs", "unread-link", "https://wiki/x", "--run", d])).toBe(2);
    expect(readFileSync(join(d, "inputs.json"), "utf8")).toBe(broken);
    expect(out).toMatch(/items/);
  });

  it("keeps fields it does not know about, so a newer run folder is not downgraded", async () => {
    const d = runDir();
    writeFileSync(join(d, "inputs.json"), JSON.stringify({ items: [], unreadLinks: [], futureField: { keep: 1 } }));
    expect(await main(["inputs", "unread-link", "https://wiki/x", "--run", d])).toBe(0);
    expect(JSON.parse(readFileSync(join(d, "inputs.json"), "utf8")).futureField).toEqual({ keep: 1 });
  });

  it("re-fetching inputs keeps the unread links already recorded (minor 8)", async () => {
    const d = runDir();
    writeFileSync(join(d, "inputs.json"), JSON.stringify({ items: [], unreadLinks: [{ url: "https://wiki/x", reason: "403" }] }));
    // `inputs` with a plain text input rewrites the file; the recorded links must survive.
    await main(["inputs", "--run", d, "some requirement text"]);
    const f = inputsFileSchema.parse(JSON.parse(readFileSync(join(d, "inputs.json"), "utf8")));
    expect(f.unreadLinks).toEqual([{ url: "https://wiki/x", reason: "403" }]);
  });
});
