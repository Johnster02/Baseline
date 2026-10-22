export type SizedInput = { kind: string; words: number; guide?: boolean };
export type RunSize = "pr" | "quick" | "full";
export const SIZES: readonly RunSize[] = ["pr", "quick", "full"];

/** Files a user could see change on the site: markup, styles, components, pages, copy. */
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl|erb|haml|hbs|ejs|twig|liquid|mdx|njk|pug)$/i;
const UI_DIR = /(^|\/)(components?|pages|app|views|templates|screens|ui|layouts?|routes|public|static|styles|assets|locales|i18n|translations|emails?)\//i;
/** Changes nobody sees on the site even if they sit in a UI folder. */
const NOT_SHIPPED = /(^|\/)(__tests__|tests?|spec|e2e|cypress|playwright|stories|__mocks__|fixtures)\/|\.(test|spec|stories)\.[jt]sx?$|\.md$/i;

export const touchesUi = (paths: string[]) => paths.some((p) => !NOT_SHIPPED.test(p) && (UI_FILE.test(p) || UI_DIR.test(p)));

/**
 * pr: one small PR (5-minute budget). quick: a single bug, ticket or short spec. full: a feature
 * with a spec or guide. The run says which before it starts.
 * Full: any folder, a file over 2,000 words, a guide, more than 15 changed files, or more than 2 personas.
 * PR: otherwise, when a PR is among the inputs and there are at most 3 inputs (the PR and its tickets).
 */
export function sizeRun(inputs: SizedInput[], changedFileCount: number, personas: string[], codeRead: boolean, changedPaths: string[] = []) {
  const full = inputs.some((i) => i.kind === "folder" || i.guide || i.words > 2000) || changedFileCount > 15 || personas.length > 2;
  const pr = !full && inputs.some((i) => i.kind === "github-pr") && inputs.length <= 3;
  const size: RunSize = full ? "full" : pr ? "pr" : "quick";
  // Code-only: a PR that changes no file a user could see. The run still checks the requirements
  // say nothing visible before skipping the browser.
  const codeOnly = pr && codeRead && changedPaths.length > 0 && !touchesUi(changedPaths);
  const plan: string[] = ["gatherer"];
  if (codeRead) plan.push("code-reader");
  if (!codeOnly) for (const p of personas.slice(0, full ? 4 : 2)) plan.push(`explorer:${p}`);
  if (full && inputs.some((i) => i.guide)) plan.push("guide-reader");
  plan.push("refuter");
  if (full) plan.push("cleaner");
  // The gatherer and refuter are counted; the cleaner only runs when something was created.
  const agents = plan.filter((p) => p !== "gatherer" && p !== "cleaner").length;
  return { size, agents, plan, codeOnly };
}
