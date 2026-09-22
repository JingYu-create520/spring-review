import { opendir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { globToRegExp, normalizeNewlines, matchesAny } from "../util/text.js";
import { reconstructFile, type DiffFile } from "./parse.js";
import { readAtRef } from "./git.js";
import type { ContentSource, ReviewUnit } from "../types.js";

export interface CollectOptions {
  cwd: string;
  /** Ref whose blob holds the `+` side, when the diff is against committed state. */
  after?: string;
  exclude?: string[];
}

export interface CollectResult {
  units: ReviewUnit[];
  skipped: Array<{ path: string; reason: string }>;
}

function langOf(path: string): ReviewUnit["lang"] {
  if (/\.java$/i.test(path)) return "java";
  if (/\.xml$/i.test(path)) return "xml";
  return "other";
}

export function isReviewable(path: string): boolean {
  if (langOf(path) === "other") return false;
  if (/[\\/](?:target|build|out|node_modules|generated)[\\/]/i.test(path)) return false;
  if (/[\\/]\.min\.[a-z]+$/i.test(path)) return false;
  return true;
}

/** Directories never worth descending into, matched against the relative path. */
const PRUNED_DIR = /(?:^|\/)(?:target|build|out|node_modules|generated|\.git)(?:\/|$)/i;

/** Every reviewable file under `dirRel` (relative to `cwd`, posix separators). */
async function walkDir(dirRel: string, cwd: string): Promise<string[]> {
  const found: string[] = [];
  const stack: string[] = [dirRel === "." ? "" : dirRel];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: Awaited<ReturnType<typeof opendir>>;
    try {
      entries = await opendir(cur === "" ? cwd : join(cwd, ...cur.split("/")));
    } catch {
      continue; // unreadable subtree: skip it rather than failing the whole run
    }
    for await (const entry of entries) {
      const rel = cur === "" ? entry.name : `${cur}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!PRUNED_DIR.test(rel)) stack.push(rel);
      } else if (entry.isFile() && isReviewable(rel)) {
        found.push(rel);
      }
    }
  }
  return found;
}

function hasGlob(s: string): boolean {
  return /[*?[]/.test(s);
}

/**
 * Turn whatever the user passed — files, directories, or globs — into a
 * de-duplicated list of reviewable relative paths.
 *
 * This exists because whole-file mode used to hand a directory straight to
 * `unitFromFile`, which returned null, so `spring-review src/` reported a clean
 * run over zero files. A linter that silently passes is worse than one that
 * errors, so an input that yields nothing is now always named in `skipped`.
 */
export async function expandReviewInputs(
  paths: string[],
  cwd: string,
  exclude: string[] = [],
): Promise<{ files: string[]; skipped: Array<{ path: string; reason: string }> }> {
  const files = new Set<string>();
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const raw of paths) {
    const rel = raw.split(sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (rel === "" || rel === ".") {
      for (const f of await walkDir(".", cwd)) files.add(f);
      continue;
    }

    if (hasGlob(rel)) {
      const wildcard = /[?*[]/.exec(rel)!.index;
      const dirEnd = rel.lastIndexOf("/", wildcard);
      const base = dirEnd === -1 ? "." : rel.slice(0, dirEnd);
      const pattern = globToRegExp(rel);
      const hit = (await walkDir(base, cwd)).filter((f) => pattern.test(f));
      if (hit.length === 0) skipped.push({ path: raw, reason: "no .java/.xml file matched this pattern" });
      for (const f of hit) files.add(f);
      continue;
    }

    const st = await stat(join(cwd, ...rel.split("/")).replace(/\\/g, sep)).catch(() => null);
    if (st === null) {
      skipped.push({ path: raw, reason: "not readable" });
      continue;
    }
    if (st.isDirectory()) {
      const hit = await walkDir(rel, cwd);
      if (hit.length === 0) skipped.push({ path: raw, reason: "no .java/.xml file under this directory" });
      for (const f of hit) files.add(f);
      continue;
    }
    if (!isReviewable(rel)) {
      skipped.push({ path: raw, reason: "not a .java/.xml file" });
      continue;
    }
    files.add(rel);
  }

  const kept = [...files].filter((f) => !(exclude.length > 0 && matchesAny(f, exclude))).sort();
  return { files: kept, skipped };
}

/**
 * Does this patch actually describe the file we have?
 *
 * Context lines are the one part of a diff that is *required* to be identical
 * text on both sides, which makes them a direct check of a question nothing else
 * in the pipeline can ask once line numbers have been trusted: `--patch` run in
 * the wrong directory, or an agent retrying `review_diff` after the tree moved,
 * otherwise report added code as clean because the numbers land somewhere else.
 *
 * Comparison ignores leading/trailing whitespace, so a reformat or a
 * tab-vs-space editor setting does not throw away a good patch.
 */
export function patchMatchesFile(file: DiffFile, content: string): boolean {
  const lines = normalizeNewlines(content).split("\n");
  const checks = [...file.contextLines.entries()];
  // Nothing to verify against: a pure addition (new file) has no context.
  if (checks.length === 0) return true;
  let matched = 0;
  for (const [line, text] of checks) {
    const actual = lines[line - 1];
    if (actual !== undefined && actual.trim() === text.trim()) matched++;
  }
  return matched / checks.length >= 0.5;
}

/**
 * Turn diff files into review units. The content always comes from the real
 * file (working tree or the diff's `+` ref) — patch text is only a last resort,
 * and units built that way are flagged `complete: false`.
 */
export async function unitsFromDiff(files: DiffFile[], opts: CollectOptions): Promise<CollectResult> {
  const units: ReviewUnit[] = [];
  const skipped: CollectResult["skipped"] = [];

  for (const file of files) {
    const path = file.path || file.oldPath || "";
    if (!path) continue;
    if (file.status === "deleted") continue;
    if (file.addedLines.size === 0) {
      skipped.push({ path, reason: "no added lines" });
      continue;
    }
    if (file.unsupported) {
      skipped.push({ path, reason: file.unsupported });
      continue;
    }
    if (!isReviewable(path)) {
      skipped.push({ path, reason: "not a .java/.xml file" });
      continue;
    }
    if (opts.exclude?.length && matchesAny(path, opts.exclude)) {
      skipped.push({ path, reason: "excluded" });
      continue;
    }

    let content: string | null = null;
    let contentSource: ContentSource = "worktree";
    if (opts.after) {
      content = await readAtRef(opts.after, path, opts.cwd);
      contentSource = "head";
    }
    if (content === null) {
      try {
        content = await readFile(join(opts.cwd, ...path.split("/")), "utf8");
        contentSource = "worktree";
      } catch {
        content = null;
      }
    }

    let complete = true;
    if (content === null) {
      const rebuilt = reconstructFile(file);
      content = rebuilt.content;
      contentSource = "patch";
      complete = rebuilt.complete;
    } else if (!patchMatchesFile(file, content)) {
      // The numbers in this patch belong to a different revision of the file.
      // Review the patch's own text and say so, rather than scoring the added
      // lines against code the patch never touched.
      const rebuilt = reconstructFile(file);
      content = rebuilt.content;
      contentSource = "patch";
      complete = false;
      skipped.push({
        path,
        reason: "patch context does not match the file on disk, so the patch's own lines were reviewed",
      });
    }

    units.push({
      path,
      content: normalizeNewlines(content),
      addedLines: new Set(file.addedLines.keys()),
      contentSource,
      complete,
      lang: langOf(path),
    });
  }

  return { units, skipped };
}

/** Whole-file mode (`--file`): every line is reportable. */
export async function unitFromFile(path: string, cwd: string): Promise<ReviewUnit | null> {
  const rel = path.split(sep).join("/").replace(/^\.\//, "");
  if (!isReviewable(rel)) return null;
  const raw = await readFile(join(cwd, ...rel.split("/")), "utf8").catch(() => null);
  if (raw === null) return null;
  return {
    path: rel,
    content: normalizeNewlines(raw),
    addedLines: null,
    contentSource: "worktree",
    complete: true,
    lang: langOf(rel),
  };
}
