// Which browser a visible, hand-driven sign-in should use, and with which flags.
//
// Playwright's bundled Chromium launches with --enable-automation and an automation-controlled
// renderer. Some identity providers refuse to sign in there, which is why Baseline's own window
// looped on a site where a plain browser worked (spec 3.2). A real Chrome or Edge, with those two
// giveaways removed, behaves the way the user's own browser does.
//
// This is for the headed capture only. Run browsers stay on bundled Chromium: a run must drive
// the same browser the guard was tested against.
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** Channels in the order we would rather have them. */
export const CHANNELS = ["chrome", "msedge"] as const;
export type Channel = (typeof CHANNELS)[number];

export type LaunchChoice = {
  /** Undefined means Playwright's bundled Chromium. */
  channel?: Channel;
  args: string[];
  ignoreDefaultArgs: string[];
};

const BINARIES: Record<Channel, { darwin: string[]; linux: string[] }> = {
  chrome: {
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    linux: ["google-chrome", "google-chrome-stable", "chrome"],
  },
  msedge: {
    darwin: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    linux: ["microsoft-edge", "microsoft-edge-stable"],
  },
};

const canRun = (p: string) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/** Is this channel installed? Absolute paths on macOS, PATH lookup on Linux. */
export function channelInstalled(name: Channel, platform = process.platform, path = process.env.PATH ?? ""): boolean {
  const spec = BINARIES[name];
  if (platform === "darwin") return spec.darwin.some(canRun);
  return spec.linux.some((bin) => path.split(delimiter).filter(Boolean).some((dir) => canRun(join(dir, bin))));
}

/**
 * The browser and flags for a hand-driven sign-in. `available` is injected so this stays pure and
 * testable; it defaults to looking for a real Chrome, then Edge, then falling back to bundled
 * Chromium — which still gets the flags, because they help there too.
 */
export function chooseChannel(available: (name: Channel) => boolean = (n) => channelInstalled(n)): LaunchChoice {
  const channel = CHANNELS.find((c) => available(c));
  return {
    ...(channel ? { channel } : {}),
    // Removes the "Chrome is being controlled by automated test software" plumbing that some
    // identity providers refuse to sign in under.
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
}
