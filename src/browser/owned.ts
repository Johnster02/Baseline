// What this run created, worked out from what the browser saw, so the cleaner may delete it
// without the delete permission. Agents can't add to this: it lives in Baseline's data folder
// (out of the script sandbox's reach) and only the browser's own traffic feeds it.
//
// A record counts as the run's own when either:
//   - the site answered a write with 201 Created and a Location, or
//   - right after a write the guard allowed, the browser landed on a page whose path carries a
//     unique id that had never appeared before that write: not in a URL, not in any page or API
//     response. An id that was already on a list or in a link belongs to someone else.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDir } from "../config/secrets";
import { UNIQUE_ID } from "./guard";

/** How long after a write a landing still counts as "where the new record lives". */
export const LANDING_WINDOW_MS = 15_000;
/** Ids worth harvesting from response bodies: UUIDs and ULIDs, the shapes apps put in URLs. */
const BODY_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})\b/gi;

export function ownedFile(runDir: string): string {
  const key = createHash("sha256").update(resolve(runDir)).digest("hex").slice(0, 16);
  return join(dataDir(), "hosts", `owned-${key}.json`);
}

export class OwnedTracker {
  /** Shared with the guard's context: it reads this array for every request. */
  readonly paths: string[];
  /** Order of events, not time: an id seen in the write's own URL comes before that write. */
  private seq = 0;
  private firstSeen = new Map<string, number>();
  private lastWriteSeq = -1;
  private lastWriteAt = -Infinity;

  constructor(private file?: string) {
    let saved: string[] = [];
    if (file) { try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { saved = []; } }
    this.paths = Array.isArray(saved) ? saved.filter((p) => typeof p === "string") : [];
  }

  private see(id: string) {
    const k = id.toLowerCase();
    if (!this.firstSeen.has(k)) this.firstSeen.set(k, ++this.seq);
  }

  /** Every id in a URL the browser asked for. */
  seeUrl(url: string) {
    let path: string;
    try { path = new URL(url).pathname; } catch { return; }
    for (const seg of path.split("/")) if (UNIQUE_ID.test(seg)) this.see(seg);
  }

  /** Every UUID or ULID in a page or API response. */
  seeText(text: string) {
    for (const m of text.matchAll(BODY_ID)) this.see(m[0]);
  }

  /** The guard let a write through. */
  wrote(at = Date.now()) { this.lastWriteSeq = ++this.seq; this.lastWriteAt = at; }

  /** The site said where a new record lives (201 + Location). */
  add(path: string) {
    if (!path || this.paths.includes(path)) return;
    this.paths.push(path);
    this.save();
  }

  /** The browser landed on a page. Returns the record path it now owns, if this is one. */
  landed(url: string, at = Date.now()): string | undefined {
    let segs: string[];
    try { segs = new URL(url).pathname.split("/").filter(Boolean); } catch { return undefined; }
    let owned: string | undefined;
    if (at - this.lastWriteAt <= LANDING_WINDOW_MS) {
      segs.forEach((seg, i) => {
        if (owned || !UNIQUE_ID.test(seg)) return;
        const first = this.firstSeen.get(seg.toLowerCase());
        if (first === undefined || first > this.lastWriteSeq) owned = "/" + segs.slice(0, i + 1).join("/");
      });
    }
    for (const seg of segs) if (UNIQUE_ID.test(seg)) this.see(seg);
    if (owned) this.add(owned);
    return owned;
  }

  private save() {
    if (!this.file) return;
    // Merge with what other runners in this run already recorded.
    let onDisk: string[] = [];
    try { onDisk = JSON.parse(readFileSync(this.file, "utf8")); } catch { onDisk = []; }
    for (const p of onDisk) if (typeof p === "string" && !this.paths.includes(p)) this.paths.push(p);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(this.paths, null, 2), { mode: 0o600 });
  }
}
