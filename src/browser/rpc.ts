/** The only commands an agent script can send. Nothing here hands out Playwright objects. */
export const COMMANDS = [
  "open", "goto", "click", "fill", "press", "select", "check", "hover", "back", "waitFor",
  "snapshot", "text", "url", "title", "shot", "created", "close",
] as const;
export type Command = (typeof COMMANDS)[number];
export const isCommand = (m: unknown): m is Command => typeof m === "string" && (COMMANDS as readonly string[]).includes(m);
