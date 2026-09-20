/** Text/offset helpers shared by the parsers. All sources are LF-normalised first. */

export function normalizeNewlines(text: string): string {
  // Windows checkouts and CRLF patches would otherwise shift every regex match.
  return text.replace(/\r\n?/g, "\n");
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Precomputed line starts; `locate(offset)` is O(log n). */
export class LineIndex {
  private readonly starts: number[] = [];

  constructor(public readonly text: string) {
    this.starts.push(0);
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** 1-based line number containing `offset`. */
  lineOf(offset: number): number {
    const starts = this.starts;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  startOf(line: number): number {
    return this.starts[line - 1] ?? this.text.length;
  }

  endOf(line: number): number {
    return this.starts[line] ?? this.text.length;
  }

  /** 1-based `line` text, without the newline. */
  at(line: number): string {
    const s = this.startOf(line);
    const e = this.endOf(line);
    return this.text.slice(s, line === this.lineCount ? e : e - 1);
  }

  /** Every line, 0-indexed array; index 0 is line 1. */
  lines(): string[] {
    return this.text.split("\n");
  }

  snippet(line: number, endLine = line): string {
    const out: string[] = [];
    for (let l = line; l <= Math.min(endLine, this.lineCount); l++) {
      const t = this.at(l).trim();
      if (t) out.push(t);
    }
    const joined = out.join("\n");
    return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined;
  }
}

export const IDENT = /[A-Za-z_$][A-Za-z_$0-9]*/;

export function isIdentifierChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9_$]/.test(ch);
}

/** Split a comma list while respecting `<...>`, `(...)`, `[...]` nesting. */
export function splitTopLevel(text: string, separator = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Index of the matching close brace for the open brace at `open`. Returns -1 when unbalanced. */
export function matchBrace(text: string, open: number, opener = "{", closer = "}"): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  // `**` crosses directories, `*` does not — matches how users write excludes.
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") out += "[^/]";
    else out += escapeRegExp(ch);
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
