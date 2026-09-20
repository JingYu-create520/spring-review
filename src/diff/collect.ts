import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { normalizeNewlines, matchesAny } from "../util/text.js";
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
