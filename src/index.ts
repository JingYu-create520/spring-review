import { getDiff, type DiffSource } from "./diff/git.js";
import { unitsFromDiff, unitFromFile } from "./diff/collect.js";
import { attachCompanions, buildNamespaceIndex } from "./diff/companion.js";
import { reviewUnits } from "./rules/engine.js";
import { rules as allRules, listRules } from "./rules/index.js";
import type { ReviewOptions, ReviewResult, ReviewUnit } from "./types.js";

export * from "./types.js";
export { listRules, rules as ruleList } from "./rules/index.js";
export { reviewUnits } from "./rules/engine.js";
export { collectSuppressions, isSuppressed } from "./rules/suppression.js";
export { parseDiff, reconstructFile } from "./diff/parse.js";
export { analyzeJava, maskJavaLiterals } from "./analyze/java.js";
export { analyzeMapperXml } from "./analyze/xml.js";
export { loadConfig, mergeOptions } from "./config.js";
export { MockProvider, OpenAiCompatProvider, providerFromEnv } from "./llm/provider.js";
export { renderGithub, renderJson, renderTerminal } from "./report/index.js";

export const DEFAULT_OPTIONS: ReviewOptions = {
  minSeverity: "warn",
  exclude: [],
  experimental: false,
};

/**
 * Public entry point: a diff source in, findings out. Kept free of CLI and
 * process concerns so the MCP server and tests call the same code path.
 */
export async function reviewDiff(
  source: DiffSource,
  cwd: string,
  options: Partial<ReviewOptions> = {},
  rules = allRules,
): Promise<ReviewResult> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const { files, after, error } = await getDiff(source, cwd);
  if (error) {
    return { findings: [], units: 0, skipped: [{ path: "-", reason: error }], hitRules: [] };
  }
  const { units, skipped } = await unitsFromDiff(files, {
    cwd,
    after,
    exclude: merged.exclude,
  });
  await withCompanions(units, cwd);
  const result = reviewUnits(units, rules, merged);
  return { ...result, skipped: [...skipped, ...result.skipped] };
}

/** Whole-file mode: every line is reportable. */
export async function reviewPaths(
  paths: string[],
  cwd: string,
  options: Partial<ReviewOptions> = {},
  rules = allRules,
): Promise<ReviewResult> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const units: ReviewUnit[] = [];
  const skipped: ReviewResult["skipped"] = [];
  for (const path of paths) {
    const unit = await unitFromFile(path, cwd);
    if (!unit) {
      skipped.push({ path, reason: "not readable or not a .java/.xml file" });
      continue;
    }
    units.push(unit);
  }
  await withCompanions(units, cwd);
  const result = reviewUnits(units, rules, merged);
  return { ...result, skipped: [...skipped, ...result.skipped] };
}

/**
 * Mapper XML needs its interface to tell "unbounded" from "paginated by an
 * interceptor". Best effort: outside a git checkout there is no index, and
 * MYB005 then reports what it cannot disprove — which is why the README calls
 * out that mapper XML review works best inside the repository.
 */
async function withCompanions(units: ReviewUnit[], cwd: string): Promise<void> {
  if (!units.some((u) => u.lang === "xml")) return;
  const index = await buildNamespaceIndex(cwd);
  if (index.byNamespacePath.size === 0) return;
  await attachCompanions(units, cwd, index);
}
