const MARKER = "spring-review:disable";

/**
 * Inline suppression.
 *
 *   // spring-review:disable SPR001 "reason"      ← standalone comment: applies
 *                                                  to the NEXT line
 *   doThing(); // spring-review:disable SPR001     ← trailing comment: applies to
 *                                                  its own line (what people
 *                                                  actually write)
 *   // spring-review:disable-file MYB004           ← whole file
 *
 * `all` / a bare marker suppresses every rule. XML uses `<!-- … -->`.
 */
export interface Suppressions {
  fileLevel: Set<string>;
  byLine: Map<number, Set<string>>;
}

function tokensAfter(text: string): Set<string> {
  const after = text.slice(text.indexOf(MARKER) + MARKER.length);
  const withoutFile = after.replace(/^-file/, "");
  // Drop a trailing quoted reason, then keep bare ids and comma/space lists.
  const cleaned = withoutFile.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
  const ids = cleaned
    .split(/[\s,]+/)
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z]{3}\d{3}$|^ALL$/.test(t));
  const set = new Set<string>(ids.length ? ids : ["ALL"]);
  return set;
}

function isOwnLineComment(trimmed: string): boolean {
  return /^(\/\/|\/\*|\*|<!--|#)/.test(trimmed);
}

export function collectSuppressions(lines: string[]): Suppressions {
  const fileLevel = new Set<string>();
  const byLine = new Map<number, Set<string>>();

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (!raw.includes(MARKER)) return;
    const trimmed = raw.trim();
    const ids = tokensAfter(raw);
    if (/disable-file/.test(raw)) {
      for (const id of ids) fileLevel.add(id);
      return;
    }
    const target = isOwnLineComment(trimmed) ? line + 1 : line;
    const existing = byLine.get(target);
    if (existing) for (const id of ids) existing.add(id);
    else byLine.set(target, new Set(ids));
  });

  return { fileLevel, byLine };
}

export function isSuppressed(s: Suppressions, rule: string, line: number): boolean {
  const upper = rule.toUpperCase();
  if (s.fileLevel.has("ALL") || s.fileLevel.has(upper)) return true;
  const at = s.byLine.get(line);
  if (!at) return false;
  return at.has("ALL") || at.has(upper);
}
