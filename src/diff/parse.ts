import { normalizeNewlines } from "../util/text.js";

/**
 * Unified-diff parser whose only job is a trustworthy `new line number → content`
 * map. This is the part of the project most likely to be subtly wrong, so it is
 * deliberately strict: hunk line counts drive consumption, and anything it does
 * not understand is marked "unsupported" rather than guessed at.
 */

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "unknown";

export interface DiffFile {
  /** Path on the `+` side, repo-relative, forward slashes. */
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  /** new line number -> the added text (without `+`). */
  addedLines: Map<number, string>;
  /** new line number -> unchanged context text, used to rebuild sparse content. */
  contextLines: Map<number, string>;
  hunks: number;
  /** Set when the hunk cannot be trusted (binary / combined merge diff). */
  unsupported?: string;
}

const HUNK = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Decode a git path. Git wraps a path in quotes and escapes it C-style whenever it
 * contains a non-ASCII byte (`core.quotePath`, on by default), so a Chinese
 * filename arrives as `"src/\346\226\207\344\273\266Mapper.java"`. Reading the
 * octal groups back into UTF-8 is what makes the annotation clickable, lets
 * `--exclude` match the file, and lets the real file be read for context instead
 * of the review quietly falling back to patch text.
 */
const C_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  '"': '"',
  "\\": "\\",
};

function unquote(raw: string): string {
  const p = raw.trim();
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte);
      continue;
    }
    const octal = /^\\([0-7]{1,3})/.exec(body.slice(i));
    if (octal) {
      bytes.push(parseInt(octal[1] as string, 8));
      i += octal[0].length - 1;
      continue;
    }
    const mapped = C_ESCAPES[body[i + 1] as string];
    if (mapped !== undefined) {
      for (const byte of Buffer.from(mapped, "utf8")) bytes.push(byte);
      i += 1;
      continue;
    }
    bytes.push(0x5c); // an escape this parser does not know stays a backslash
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `a/x b/y` → [x, y]. Handles paths containing spaces when both sides match. */
function splitGitPaths(body: string): [string, string] | undefined {
  const noSpaces = /^a\/(\S+) b\/(\S+)$/.exec(body);
  if (noSpaces) return [noSpaces[1] as string, noSpaces[2] as string];
  // Symmetric path (the common `diff --git a/dir with space/f b/dir with space/f`).
  const mid = Math.floor(body.length / 2);
  if (body.startsWith("a/") && body.length % 2 === 1) {
    const left = body.slice(2, mid);
    const right = body.slice(mid + 1);
    if (left === right) return [left, right];
  }
  const at = body.indexOf(" b/");
  if (at > 0 && body.startsWith("a/")) {
    return [unquote(body.slice(2, at)), unquote(body.slice(at + 3))];
  }
  return undefined;
}

function cleanSide(raw: string | undefined): string {
  if (!raw) return "";
  const p = unquote(raw).replace(/\t.*$/, ""); // git may append a tab + timestamp
  if (p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

interface Hunk {
  newStart: number;
  newCount: number;
  oldStart: number;
  oldCount: number;
}

export function parseDiff(text: string): DiffFile[] {
  const lines = normalizeNewlines(text).split("\n");
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let pendingOld: string | undefined;
  let pendingNew: string | undefined;

  const startFile = (path: string, oldPath?: string, unsupported?: string): DiffFile => {
    const file: DiffFile = {
      path,
      addedLines: new Map(),
      contextLines: new Map(),
      status: "unknown",
      hunks: 0,
    };
    if (oldPath) file.oldPath = oldPath;
    if (unsupported) file.unsupported = unsupported;
    return file;
  };

  const flush = () => {
    if (!current) return;
    if (!current.path) current.path = cleanSide(pendingNew) || cleanSide(pendingOld);
    if (current.status === "unknown") {
      if (!pendingOld || pendingOld.includes("/dev/null")) current.status = "added";
      else if (!pendingNew || pendingNew.includes("/dev/null")) current.status = "deleted";
      else if (current.oldPath && current.path !== current.oldPath) current.status = "renamed";
      else current.status = "modified";
    }
    if (current.path) files.push(current);
    current = null;
    pendingOld = undefined;
    pendingNew = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      flush();
      const combined = line.startsWith("diff --cc ");
      const paths = combined ? undefined : splitGitPaths(line.slice("diff --git ".length));
      current = startFile(
        paths ? paths[1] : "",
        paths ? paths[0] : undefined,
        combined ? "combined merge diff is not supported" : undefined,
      );
      continue;
    }

    if (!current) {
      // patch(1) / `git diff --no-index` output has no `diff --git` header.
      if (line.startsWith("--- ")) pendingOld = line.slice(4);
      else if (line.startsWith("+++ ")) pendingNew = line.slice(4);
      else if (HUNK.test(line)) current = startFile(cleanSide(pendingNew) || cleanSide(pendingOld));
      else continue;
      if (!current) continue;
    }
    const file = current;

    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      file.oldPath = unquote(line.slice(line.startsWith("rename") ? 12 : 10));
      file.status = "renamed";
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      file.path = unquote(line.slice(line.startsWith("rename") ? 10 : 8));
      file.status = "renamed";
    } else if (line.startsWith("similarity index") || line.startsWith("old mode")) {
      if (file.status === "unknown") file.status = "renamed";
    } else if (line.startsWith("Binary files")) {
      file.unsupported = "binary file";
    } else if (line.startsWith("--- ")) {
      pendingOld = line.slice(4);
    } else if (line.startsWith("+++ ")) {
      pendingNew = line.slice(4);
      const p = cleanSide(pendingNew);
      if (p) file.path = p;
      const old = cleanSide(pendingOld);
      if (old && !file.oldPath) file.oldPath = old;
    } else if (HUNK.test(line)) {
      const m = HUNK.exec(line) as RegExpExecArray;
      const hunk: Hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
      };
      file.hunks++;
      i = consumeHunk(lines, i + 1, file, hunk);
      continue;
    }
  }
  flush();

  return files;
}

/** Walk one hunk honouring its declared line counts; returns the last consumed index. */
function consumeHunk(lines: string[], start: number, file: DiffFile, hunk: Hunk): number {
  if (hunk.newCount === 0) {
    // Pure deletion: skip the removed lines so numbering of the next hunk stays sane.
    let old = 0;
    let i = start;
    for (; i < lines.length && old < hunk.oldCount; i++) {
      const line = lines[i] as string;
      if (line.startsWith("-")) old++;
      else if (line.startsWith("\\") || line === "") continue;
      else break;
    }
    return i - 1;
  }

  let newLine = hunk.newStart - 1;
  let newSeen = 0;
  let oldSeen = 0;
  let i = start;

  for (; i < lines.length; i++) {
    if (newSeen >= hunk.newCount && oldSeen >= hunk.oldCount) break;
    const line = lines[i] as string;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = line.charAt(0);
    const body = line.slice(1);

    if (marker === "+") {
      newLine++;
      newSeen++;
      file.addedLines.set(newLine, body);
    } else if (marker === "-") {
      oldSeen++;
    } else if (marker === " " || marker === "" || body === "") {
      // A blank context line may arrive as "" from tools that strip the space.
      if (marker === "" && line !== "") break;
      newLine++;
      newSeen++;
      oldSeen++;
      file.contextLines.set(newLine, marker === " " ? body : line);
    } else {
      // Any other leading char starts a new section (`@@`, `diff`, `index`, …).
      break;
    }

    if (newSeen > hunk.newCount || oldSeen > hunk.oldCount) {
      // Malformed / truncated patch: stop trusting this hunk rather than drifting.
      file.unsupported = file.unsupported ?? "hunk line counts do not match";
      break;
    }
  }
  return i - 1;
}

/**
 * Rebuild a file body from the diff when the real file is not on disk
 * (`--patch` from another checkout). Unknown lines stay empty so reported line
 * numbers still match HEAD; `complete` tells structure-heavy rules to back off.
 */
export function reconstructFile(file: DiffFile): { content: string; complete: boolean } {
  const keys = [...Array.from(file.addedLines.keys()), ...Array.from(file.contextLines.keys())];
  if (keys.length === 0) return { content: "", complete: true };
  const max = Math.max(...keys);
  const min = Math.min(...keys);
  const known = new Set(keys);
  const out: string[] = [];
  for (let line = 1; line <= max; line++) {
    const text = file.addedLines.get(line) ?? file.contextLines.get(line);
    out.push(text === undefined ? "" : text);
  }
  // Contiguous from line 1 ⇒ we saw every line of the file; otherwise there are
  // holes above/between hunks and structure-dependent rules must back off.
  const contiguous = min === 1 && known.size === max;
  return { content: `${out.join("\n")}\n`, complete: contiguous && !file.unsupported };
}
