export type SizedInput = { kind: string; words: number; guide?: boolean };

/**
 * Quick for a single bug or PR, full for a feature with a spec or guide. The run says which before it starts.
 * Full: any folder, a file over 2,000 words, a guide, more than 15 changed files, or more than 2 personas.
 */
export function sizeRun(inputs: SizedInput[], changedFileCount: number, personas: string[], codeRead: boolean) {
  const full = inputs.some((i) => i.kind === "folder" || i.guide || i.words > 2000) || changedFileCount > 15 || personas.length > 2;
  const size: "quick" | "full" = full ? "full" : "quick";
  const plan: string[] = ["gatherer"];
  if (codeRead) plan.push("code-reader");
  const explorers = personas.slice(0, full ? 4 : 2);
  for (const p of explorers) plan.push(`explorer:${p}`);
  if (full && inputs.some((i) => i.guide)) plan.push("guide-reader");
  plan.push("refuter");
  if (full) plan.push("cleaner");
  // The gatherer and refuter are counted; the cleaner only runs when something was created.
  const agents = plan.filter((p) => p !== "gatherer" && p !== "cleaner").length;
  return { size, agents, plan };
}
