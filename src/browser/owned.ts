// What this run created, worked out from what the browser saw, so the cleaner may delete it
// without the delete permission. Agents can't add to this: it lives in Baseline's data folder
// (out of the script sandbox's reach) and only the browser's own traffic feeds it.
//
// A record counts as the run's own when either:
//   - the site answered a write with 201 Created and a Location, or
//   - right after a write the guard allowed, the browser was taken (not sent by the agent) to a
//     page whose path carries a unique id that first appeared in the site's reply to that write.
//     An id already on a list, in a link or in a URL the agent asked for belongs to someone else.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDir } from "../config/secrets";
import { UNIQUE_ID } from "./guard";

/** How long after a write a landing still counts as "where the new record lives". */
export const LANDING_WINDOW_MS = 15_000;
/** Ids worth harvesting from response bodies: UUIDs and ULIDs, the shapes apps put in URLs. */
const BODY_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})\b/gi;
/** Request side: no word boundaries, so an id glued to other text is still caught. */
const ANY_ID = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})/gi;

/**
 * Every way a server might read a request: raw, percent-decoded, form fields, JSON string
 * values. `clean` is false when something could not be decoded, and then nothing reached right
 * after this write may count as created (fail closed).
 */
export function requestTexts(url: string, body?: string): { texts: string[]; clean: boolean } {
  const texts: string[] = [url];
  let clean = true;
  const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { clean = false; return s; } };
  const walk = (v: unknown): void => {
    if (typeof v === "string") texts.push(v, dec(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { texts.push(k); walk(x); }
  };
  texts.push(dec(url));
  try { for (const [k, v] of new URL(url).searchParams) texts.push(k, v, dec(v)); } catch { clean = false; }
  if (body) {
    texts.push(body, dec(body));
    try { for (const [k, v] of new URLSearchParams(body)) texts.push(k, v); } catch { /* not a form */ }
    const t = body.trim();
    if (t.startsWith("{") || t.startsWith("[")) { try { walk(JSON.parse(t)); } catch { clean = false; } }
  }
  return { texts, clean };
}

export function ownedFile(runDir: string): string {
  const key = createHash("sha256").update(resolve(runDir)).digest("hex").slice(0, 16);
  return join(dataDir(), "hosts", `owned-${key}.json`);
}

export class OwnedTracker {
  /** Shared with the guard's context: it reads this array for every request. */
  readonly paths: string[];
  /** Order of events, not time: an id seen in the write's own URL comes before that write. */
  private seq = 0;
  /** When each id was first seen, and whether the site's reply was where it showed up. */
  private firstSeen = new Map<string, { seq: number; reply: boolean }>();
  private lastWriteSeq = -1;
  private lastWriteAt = -Infinity;
  /** False when the last write could not be fully decoded: nothing after it counts as created. */
  private lastWriteClean = true;

  constructor(private file?: string) {
    let saved: string[] = [];
    if (file) { try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { saved = []; } }
    this.paths = Array.isArray(saved) ? saved.filter((p) => typeof p === "string") : [];
  }

  private see(id: string, reply: boolean) {
    const k = id.toLowerCase();
    if (!this.firstSeen.has(k)) this.firstSeen.set(k, { seq: ++this.seq, reply });
  }

  /** Every id in a URL the browser asked for. */
  seeUrl(url: string) {
    let path: string;
    try { path = new URL(url).pathname; } catch { return; }
    for (const seg of path.split("/")) if (UNIQUE_ID.test(seg)) this.see(seg, false);
  }

  /** Every UUID or ULID in a page or API response, or a redirect's Location. */
  seeText(text: string) {
    for (const m of text.matchAll(BODY_ID)) this.see(m[0], true);
  }

  /** A same-site path the site's reply redirects to: its UUIDs and ULIDs count as the reply's. */
  seeReplyPath(path: string) {
    for (const m of path.matchAll(BODY_ID)) this.see(m[0], true);
  }

  /**
   * A write about to go out: every id it names (path, query, body) came from the request, so a
   * reply that echoes one back can never make it look new.
   */
  seeRequest(url: string, body?: string): boolean {
    this.seeUrl(url);
    const { texts, clean } = requestTexts(url, body);
    for (const text of texts) for (const m of text.matchAll(ANY_ID)) this.see(m[0], false);
    return clean;
  }

  /** The guard let a write through. */
  wrote(at = Date.now(), clean = true) { this.lastWriteSeq = ++this.seq; this.lastWriteAt = at; this.lastWriteClean = clean; }

  /** The site said where a new record lives (201 + Location). */
  add(path: string) {
    if (!path || this.paths.includes(path)) return;
    this.paths.push(path);
    this.save();
  }

  /**
   * The browser landed on a page. Returns the record path it now owns, if this is one: the id
   * must have shown up first in the site's reply after the write (a response body or redirect),
   * never in a URL the browser asked for. Pages the agent opened itself (`byAgent`, a goto)
   * never count, so knowing an id and visiting it can't make it ours.
   */
  landed(url: string, at = Date.now(), byAgent = false): string | undefined {
    let segs: string[];
    try { segs = new URL(url).pathname.split("/").filter(Boolean); } catch { return undefined; }
    let owned: string | undefined;
    if (!byAgent && this.lastWriteClean && at - this.lastWriteAt <= LANDING_WINDOW_MS) {
      segs.forEach((seg, i) => {
        if (owned || !UNIQUE_ID.test(seg)) return;
        const first = this.firstSeen.get(seg.toLowerCase());
        if (first && first.reply && first.seq > this.lastWriteSeq) owned = "/" + segs.slice(0, i + 1).join("/");
      });
    }
    for (const seg of segs) if (UNIQUE_ID.test(seg)) this.see(seg, false);
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
