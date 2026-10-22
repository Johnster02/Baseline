export function leakCheck(files: string[], bannedTermsFile: string): { file: string; line: number; term: string }[];
export function leakCheckAuthors(lines: string[], bannedTermsFile: string): { commit: string; term: string }[];
