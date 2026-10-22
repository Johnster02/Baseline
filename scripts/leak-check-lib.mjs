import { existsSync, readFileSync } from "node:fs";

/**
 * Scan files for banned terms (case-insensitive).
 * @param {string[]} files
 * @param {string} bannedTermsFile one term per line; kept outside the repo
 * @returns {{file: string, line: number, term: string}[]}
 */
export function leakCheck(files, bannedTermsFile) {
  if (!existsSync(bannedTermsFile)) return [];
  const terms = readFileSync(bannedTermsFile, "utf8")
    .split("\n").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const hits = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      const lower = line.toLowerCase();
      for (const term of terms) if (lower.includes(term)) hits.push({ file, line: i + 1, term });
    });
  }
  return hits;
}
