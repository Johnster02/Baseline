export type AdfNode = { type?: string | undefined; text?: string | undefined; content?: AdfNode[] | undefined };
type Node = AdfNode;

/** Atlassian Document Format to plain text: paragraphs and headings on their own lines, list items prefixed. */
export function adfToText(node: Node | null | undefined): string {
  if (!node) return "";
  const lines: string[] = [];
  const inline = (n: Node): string => (n.text ?? "") + (n.content ?? []).map(inline).join("");
  const walk = (n: Node, prefix = "") => {
    if (n.type === "paragraph" || n.type === "heading") { lines.push(prefix + inline(n)); return; }
    if (n.type === "listItem") { (n.content ?? []).forEach((c, i) => walk(c, i === 0 ? "- " : "  ")); return; }
    if (n.type === "codeBlock") { lines.push(inline(n)); return; }
    (n.content ?? []).forEach((c) => walk(c, prefix));
  };
  walk(node);
  return lines.filter((l) => l.trim() !== "").join("\n");
}
