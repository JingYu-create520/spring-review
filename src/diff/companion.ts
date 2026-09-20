import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeNewlines } from "../util/text.js";
import { gitRaw } from "./git.js";

/**
 * MyBatis-Plus / PageHelper pagination lives in the *interface*
 * (`IPage<User> selectPage(IPage<User> page, @Param …)`), so a mapper XML on its
 * own cannot tell MYB005 "this unbounded-looking select is actually paged".
 * Without that link the rule would fire on every paged query in a MyBatis-Plus
 * codebase, which is exactly the false positive this project cannot afford.
 *
 * The namespace → file mapping is resolved against `git ls-files`, so it costs
 * one command and no filesystem walk. Outside a git checkout we simply have no
 * companion and MYB005 stays quiet about paged-looking statements it cannot prove.
 */
export interface NamespaceIndex {
  /** `com/example/demo/mapper/UserMapper.java` -> repo path. */
  byNamespacePath: Map<string, string>;
}

export async function buildNamespaceIndex(cwd: string): Promise<NamespaceIndex> {
  const out = await gitRaw(["ls-files", "-z", "--", "*.java"], cwd);
  const byNamespacePath = new Map<string, string>();
  if (!out) return { byNamespacePath };
  for (const raw of out.split("\0")) {
    if (!raw) continue;
    const path = raw.split("\\").join("/");
    const marker = path.lastIndexOf("/java/");
    const key = marker >= 0 ? path.slice(marker + "/java/".length) : path;
    if (!byNamespacePath.has(key)) byNamespacePath.set(key, path);
    // Also allow the bare `src/main/java/...` form used by some layouts.
    const alt = path.replace(/^.*?src\/(?:main|test)\/java\//, "");
    if (alt !== path && !byNamespacePath.has(alt)) byNamespacePath.set(alt, path);
  }
  return { byNamespacePath };
}

export function namespaceToPath(namespace: string): string {
  return `${namespace.trim().split(".").join("/")}.java`;
}

/** Attach `companion` to every mapper XML unit whose interface exists. */
export async function attachCompanions(
  units: Array<{ path: string; lang: string; content: string; companion?: { path: string; content: string } }>,
  cwd: string,
  index: NamespaceIndex,
): Promise<void> {
  for (const unit of units) {
    if (unit.lang !== "xml") continue;
    const m = /<mapper\s+namespace=["']([^"']+)["']/i.exec(unit.content);
    const namespace = m?.[1];
    if (!namespace) continue;
    const key = namespaceToPath(namespace);
    const repoPath = index.byNamespacePath.get(key);
    if (!repoPath) continue;
    const content = await readFile(join(cwd, ...repoPath.split("/")), "utf8").catch(() => null);
    if (content === null) continue;
    unit.companion = { path: repoPath, content: normalizeNewlines(content) };
  }
}
