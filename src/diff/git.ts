import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseDiff, type DiffFile } from "./parse.js";

const run = promisify(execFile);

/**
 * Shelling out to git keeps the tool dependency-free and lets it run offline in
 * CI. Every failure returns `null` so the caller can fall back to patch
 * reconstruction instead of crashing on a non-repository directory.
 */
export async function gitRaw(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: "buffer",
    }).then((r) => ({ stdout: r.stdout.toString("utf8") }));
    return stdout;
  } catch {
    return null;
  }
}

export type DiffSource =
  | { kind: "worktree" }
  | { kind: "staged" }
  /**
   * `after` names the ref whose blobs hold the `+` side, so file content matches
   * the reviewed commit instead of the working tree. Omit it when git is comparing
   * against the working tree (`git diff HEAD~1`).
   */
  | { kind: "range"; range: string; after?: string }
  | { kind: "patch"; text: string; after?: string };

export function diffArgs(source: DiffSource): string[] | null {
  switch (source.kind) {
    case "worktree":
      return ["diff", "--no-color", "--unified=3", "HEAD"];
    case "staged":
      return ["diff", "--no-color", "--unified=3", "--cached"];
    case "range":
      return ["diff", "--no-color", "--unified=3", source.range];
    case "patch":
      return null;
  }
}

export interface CollectedDiff {
  files: DiffFile[];
  /** Ref the `+` side belongs to: use it to read file content, or undefined for worktree. */
  after: string | undefined;
  error?: string;
}

export async function getDiff(source: DiffSource, cwd: string): Promise<CollectedDiff> {
  if (source.kind === "patch") {
    return { files: parseDiff(source.text), after: source.after };
  }
  const args = diffArgs(source);
  if (!args) return { files: [], after: undefined, error: "no diff source" };
  const out = await gitRaw(args, cwd);
  if (out === null) {
    return {
      files: [],
      after: undefined,
      error: "not a git repository or `git diff` failed — pass --patch <file> instead",
    };
  }
  return { files: parseDiff(out), after: source.kind === "range" ? source.after : undefined };
}

/**
 * Source files git is not tracking yet. `git diff HEAD` cannot see them, so the
 * default run — "review what I am working on" — answered `no findings` with a
 * brand-new service class sitting untracked in the tree, which is the first thing
 * a new user does. Paths come back relative to the repository root even when git
 * is invoked from a subdirectory.
 */
export async function untrackedFiles(cwd: string): Promise<string[]> {
  const out = await gitRaw(
    ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"],
    cwd,
  );
  if (out === null) return [];
  const paths: string[] = [];
  for (const entry of out.split("\0")) {
    if (!entry.startsWith("?? ")) continue;
    const path = entry.slice(3).trim().replace(/\\/g, "/");
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** `git show <ref>:<path>` — returns null when the blob does not exist there. */
export async function readAtRef(ref: string, path: string, cwd: string): Promise<string | null> {
  return gitRaw(["show", `${ref}:${path}`], cwd);
}

export async function isGitWorktree(cwd: string): Promise<boolean> {
  const out = await gitRaw(["rev-parse", "--is-inside-work-tree"], cwd);
  return (out ?? "").trim() === "true";
}

/**
 * The directory every repository-relative path is relative to.
 *
 * `git status --porcelain` and `git diff` print paths from the top level even
 * when invoked in a subdirectory, so a monorepo module (`cd backend &&
 * spring-review`) cannot read its own changes from the directory it was started
 * in: `join(cwd, "src/A.java")` points at `backend/backend/src/A.java`. This is
 * the base the file reads use; git itself still runs wherever the user was.
 */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  const out = await gitRaw(["rev-parse", "--show-toplevel"], cwd);
  const root = (out ?? "").trim();
  return root === "" ? undefined : root;
}
