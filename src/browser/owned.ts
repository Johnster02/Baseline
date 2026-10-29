// What this run created, worked out from what the browser saw, so the cleaner may delete it
// without the delete permission. Agents can't add to this: it lives in Baseline's data folder
// (out of the script sandbox's reach) and only the browser's own traffic feeds it. Every runner's
// host shares the file, and each re-reads it when it changes, so one role can clean up another's.
//
// A record counts as the run's own when either:
//   - the site answered a write with 201 Created and a Location, or
//   - right after a write the guard allowed, the browser was taken (not sent by the agent) to a
//     page whose path carries a unique id that first appeared in the site's reply to that write.
//     An id already on a list, in a link or in a URL the agent asked for belongs to someone else.
//     A landing without a page load (a client-side route change) counts only when no click came
//     between the write and the landing, or the site's reply named that path.
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJsonl, readJsonFile, readJsonl } from "../core/json";
import { dataDir, runKey, trustedRunDir } from "../core/paths";
import { UNIQUE_ID } from "./guard";

/** How long after a write a landing still counts as "where the new record lives". */
export const LANDING_WINDOW_MS = 15_000;
/** Ids worth harvesting from response bodies: UUIDs and ULIDs, the shapes apps put in URLs. */
const BODY_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})\b/gi;
/** Request side: no word boundaries, so an id glued to other text is still caught. */
const ANY_ID = /(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})/gi;

/**
 * One canonical form for comparing ids with anything a request carried: decoded until it stops
 * changing, HTML entities resolved, lower case, Crockford look-alikes folded (i/l to 1, o to 0),
 * and everything but letters and digits dropped. However an id was disguised, it reduces to this.
 */
export function canon(s: string): string {
  return canonDeep(s).text;
}

/** canon, plus whether decoding settled: still-encoded text after five rounds is "unclear". */
function canonDeep(s: string): { text: string; settled: boolean } {
  let t = s;
  let settled = false;
  for (let i = 0; i < 5; i++) {
    let next = t.replace(/\+/g, " ");
    try { next = decodeURIComponent(next); } catch { /* keep what decoded */ }
    next = next
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&(amp|hyphen|dash|minus);/gi, "-")
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (next === t) { settled = true; break; }
    t = next;
  }
  // Five rounds that never settled still count as settled when nothing encoded is left.
  if (!settled && !/%[0-9a-f]{2}|&#|\\u[0-9a-f]{4}/i.test(t)) settled = true;
  return { text: t.toLowerCase().replace(/[il]/g, "1").replace(/o/g, "0").replace(/[^0-9a-z]/g, ""), settled };
}

/** How much of what the run sent is kept for the never-sent check. Past this, nothing new is owned. */
const SENT_LIMIT = 8_000_000;

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
  return join(trustedRunDir(runDir), "owned.jsonl");
}

/**
 * Baseline's own copy of what agents said they created (JSONL, data folder). Agents can add to it
 * through `s.created()`, but can't edit or remove what is already there.
 */
export function createdFile(runDir: string): string {
  return join(trustedRunDir(runDir), "created.jsonl");
}

export type CreatedEntry = {
  runner: string;
  kind: string;
  label: string;
  /** The record's own address, same-site and usable. Absent when the agent gave a placeholder. */
  url?: string;
  /** The agent passed something template-shaped (`/projects/<id>`), so there is no address. */
  urlUnusable: boolean;
  /** Where the browser actually was when this was recorded. Baseline's own observation. */
  pageUrl: string;
  /** This entry's path is one the browser independently watched the site create. */
  confirmed: boolean;
  labelled: boolean;
  /** When it was recorded. */
  at: string;
};

const isCreated = (v: unknown): CreatedEntry => {
  const o = v as Partial<CreatedEntry> | null;
  if (!o || typeof o.runner !== "string" || typeof o.kind !== "string" || typeof o.label !== "string") throw new Error("not a created entry");
  // Entries written before pageUrl/confirmed/urlUnusable existed still read, as unconfirmed.
  return {
    runner: o.runner, kind: o.kind, label: o.label,
    ...(typeof o.url === "string" ? { url: o.url } : {}),
    urlUnusable: o.urlUnusable === true,
    pageUrl: typeof o.pageUrl === "string" ? o.pageUrl : "",
    confirmed: o.confirmed === true,
    labelled: o.labelled === true,
    at: String(o.at ?? ""),
  };
};

/**
 * A url an agent passed that is a template, not an address: `/projects/<id>`, `{id}`, `[id]`
 * (Next.js), `[...slug]`, `${id}`, `$id`, `:id`, `*`. Recording one as the record's address is
 * what nearly sent the cleaner to the wrong place.
 *
 * Only the path is examined, and only whole segments count. A real query string often carries
 * brackets and dollars of its own — `?filter[status]=published`, `?ids[]=1`, OData's `?$top=10` —
 * and treating those as templates dropped the address of a record that really existed, leaving it
 * behind on the site (review finding M-1).
 */
export const isPlaceholderUrl = (url: string) => {
  const path = url.split(/[?#]/)[0] ?? url;
  let t = path;
  try { t = decodeURIComponent(path); } catch { /* compare what we have */ }
  if (/[<>{}*]/.test(t)) return true;
  // A whole segment that is a placeholder: [id], [...slug], $id, ${id}, :id.
  // `${id}` is unambiguously a template. A bare `$name` segment is not — `/odata/$metadata` is a
  // real endpoint — and it costs nothing to allow, because an address Baseline did not watch the
  // site create is `confirmed: false`, and the cleaner never navigates to one of those.
  return t.split("/").some((seg) => /^\[.*\]$/.test(seg) || /^\$\{.*\}$/.test(seg) || /^:[A-Za-z_]/.test(seg));
};

export function appendCreated(runDir: string, entry: CreatedEntry): void {
  const f = createdFile(runDir);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  appendJsonl(f, entry, 0o600);
}

/** The trusted created list (plus the older JSON-array file of runs from before JSONL). */
export function readCreated(runDir: string): CreatedEntry[] {
  const legacy = readJsonFile(join(dataDir(), "hosts", `created-${runKey(runDir)}.json`), (v) => (Array.isArray(v) ? v : []), [] as unknown[]);
  const old = legacy.flatMap((v) => { try { return [isCreated(v)]; } catch { return []; } });
  return [...old, ...readJsonl(createdFile(runDir), isCreated)];
}

const asPath = (v: unknown): string => { if (typeof v !== "string" || !v.startsWith("/")) throw new Error("not a path"); return v; };

export class OwnedTracker {
  /** Shared with the guard's context: it reads this array for every request. */
  readonly paths: string[];
  /** Order of events, not time: an id seen in the write's own URL comes before that write. */
  private seq = 0;
  /** When each id was first seen, and whether the site's reply was where it showed up. */
  private firstSeen = new Map<string, { seq: number; reply: boolean }>();
  private lastWriteSeq = -1;
  private lastWriteAt = -Infinity;
  /** Until this time nothing counts as created: a write that couldn't be decoded sets it. */
  private dirtyUntil = -Infinity;
  /** Every request this run sent, in canonical form (see canon). */
  private sent: string[] = [];
  private sentSize = 0;
  /** Canonical paths the site's replies redirected to: loading exactly one of these is following it. */
  private replyTargets = new Set<string>();
  /** Order of the agent's last click: a client-side landing after a later click is the agent's doing. */
  private lastClickSeq = -1;
  /** The file's size and mtime when last read, so other runners' additions are picked up. */
  private seen = "";

  constructor(private file?: string) {
    this.paths = [];
    this.refresh();
  }

  /**
   * Merge in what other runners recorded since the last read. Cheap when nothing changed. The file
   * is append-only JSONL (one path per line), so runners writing at once never lose each other's.
   */
  refresh(): void {
    if (!this.file) return;
    let st;
    try { st = statSync(this.file); } catch { return; }
    const sig = `${st.size}:${st.mtimeMs}`;
    if (sig === this.seen) return;
    this.seen = sig;
    for (const p of readJsonl(this.file, asPath)) if (!this.paths.includes(p)) this.paths.push(p);
  }

  /** The agent clicked something. */
  clicked(): void { this.lastClickSeq = ++this.seq; }

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
    this.replyTargets.add(canon(path));
  }

  /** A request that couldn't be decoded: nothing reached in the next window counts as created. */
  markUnclear(at = Date.now()) { this.dirtyUntil = Math.max(this.dirtyUntil, at + LANDING_WINDOW_MS); }

  /**
   * A write about to go out: every id it names (path, query, body) came from the request, so a
   * reply that echoes one back can never make it look new.
   */
  seeRequest(url: string, body?: string, write = true): boolean {
    const { texts, clean } = requestTexts(url, body);
    // Every request goes in the never-sent record, except the path of a page load that is exactly
    // where the site's reply redirected (compared in canonical form, so a disguised id can't pass
    // as one). Its query string is still recorded.
    let path = "", search = "";
    try { const u = new URL(url); path = u.pathname; search = u.search; } catch { path = url; }
    const followsReply = !write && this.replyTargets.has(canon(path));
    let settled = true;
    if (followsReply) {
      if (search) { const d = canonDeep(search); if (!d.settled) settled = false; this.sent.push(d.text); this.sentSize += d.text.length; }
    } else {
      // The whole request, and each field value on its own, so neighbours can't hide an id.
      for (const t of [url + "\n" + (body ?? ""), ...texts]) {
        const d = canonDeep(t);
        if (!d.settled) settled = false;
        this.sent.push(d.text);
        this.sentSize += d.text.length;
      }
    }
    this.seeUrl(url);
    for (const text of texts) for (const m of text.matchAll(ANY_ID)) this.see(m[0], false);
    return clean && settled;
  }

  /** Did any request this run sent carry this id, in any disguise? Unsure (too much sent) is yes. */
  private everSent(id: string): boolean {
    if (this.sentSize > SENT_LIMIT) return true;
    const c = canon(id);
    return this.sent.some((s) => s.includes(c));
  }

  /** The guard let a write through. */
  wrote(at = Date.now(), clean = true) {
    this.lastWriteSeq = ++this.seq;
    this.lastWriteAt = at;
    // Sticky: a later clean write never clears an earlier unclear one's window.
    if (!clean) this.dirtyUntil = Math.max(this.dirtyUntil, at + LANDING_WINDOW_MS);
  }

  /** The site said where a new record lives (201 + Location). */
  add(path: string) {
    if (!path || this.paths.includes(path)) return;
    this.paths.push(path);
    this.save(path);
  }

  /**
   * The browser landed on a page. Returns the record path it now owns, if this is one: the id
   * must have shown up first in the site's reply after the write (a response body or redirect),
   * never in a URL the browser asked for. Pages the agent opened itself (`byAgent`, a goto)
   * never count, so knowing an id and visiting it can't make it ours. A landing without a page
   * load (`document: false`, a client-side route change) counts only when no click came after the
   * write, or the site's reply named this path: clicking a fresh row in a list is not "created".
   */
  landed(url: string, at = Date.now(), byAgent = false, opts: { document?: boolean } = {}): string | undefined {
    let path: string;
    try { path = new URL(url).pathname; } catch { return undefined; }
    const segs = path.split("/").filter(Boolean);
    const clientSide = opts.document === false;
    const followsSite = !clientSide || this.lastClickSeq < this.lastWriteSeq || this.replyTargets.has(canon(path));
    let owned: string | undefined;
    if (!byAgent && followsSite && at > this.dirtyUntil && at - this.lastWriteAt <= LANDING_WINDOW_MS) {
      segs.forEach((seg, i) => {
        if (owned || !UNIQUE_ID.test(seg)) return;
        const first = this.firstSeen.get(seg.toLowerCase());
        if (first && first.reply && first.seq > this.lastWriteSeq && !this.everSent(seg)) owned = "/" + segs.slice(0, i + 1).join("/");
      });
    }
    for (const seg of segs) if (UNIQUE_ID.test(seg)) this.see(seg, false);
    if (owned) this.add(owned);
    return owned;
  }

  private save(path: string) {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    appendJsonl(this.file, path, 0o600);
    this.refresh();
  }
}
