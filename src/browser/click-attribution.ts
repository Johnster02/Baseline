// Which click a write came from. A click's words judge every write it could have caused, for a
// short window. Pure (the clock is injected) so click → telemetry → navigate → delete sequences can
// be tested without a browser.

export const CLICK_WINDOW_MS = 4000;
/** The click binding can land just after the request it caused: a write with no click waits this long once. */
export const CLICK_LATE_MS = 40;

type Click = { text: string; at: number; judged: boolean };

export type ClickView = {
  /** The live clicks' words, joined, or undefined when none has words. */
  text?: string | undefined;
  /** Live clicks exist but none has any words: the control can't be judged by what it says. */
  wordless: boolean;
  /** When this view was taken: only clicks made before it can be judged by the write it describes. */
  at: number;
};

export class ClickAttribution {
  private clicks: Click[] = [];
  constructor(private readonly now: () => number = Date.now, private readonly windowMs = CLICK_WINDOW_MS) {}

  record(text: string): void {
    this.clicks.push({ text: String(text || "").trim(), at: this.now(), judged: false });
  }

  private prune(): void {
    const now = this.now();
    this.clicks = this.clicks.filter((c) => now - c.at <= this.windowMs);
  }

  get live(): number { this.prune(); return this.clicks.length; }

  view(): ClickView {
    this.prune();
    const words = this.clicks.map((c) => c.text).filter(Boolean);
    return { text: words.join(" | ") || undefined, wordless: this.clicks.length > 0 && words.length === 0, at: this.now() };
  }

  /** A view, waiting once for a late click binding when a write arrives with no click yet. */
  async viewForWrite(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<ClickView> {
    const v = this.view();
    if (v.text || v.wordless) return v;
    await sleep(CLICK_LATE_MS);
    return this.view();
  }

  /**
   * A write on the site was decided with `view`'s words. Only an allowed write counts as the
   * click's own: a blocked one (a telemetry call the words caught, say) leaves the click live, so
   * the real write that follows is still judged by it. Only clicks made before the write count.
   */
  decided(view: ClickView, allowed: boolean): void {
    if (!allowed) return;
    for (const c of this.clicks) if (c.at <= view.at) c.judged = true;
  }

  /** The page moved on: clicks whose write has been judged end here; the rest stay live. */
  navigated(): void {
    this.clicks = this.clicks.filter((c) => !c.judged);
  }
}
