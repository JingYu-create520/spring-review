import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ReviewOptions, Severity } from "./types.js";

// Team-level configuration, so a repo can turn rules off once instead of
// littering inline suppressions. CLI flags always win over the file.
//
//   .spring-review.json
//   {
//     "exclude": ["**/generated/**"],
//     "disable": ["SPR005"],
//     "minSeverity": "warn"
//   }
const ConfigSchema = z
  .object({
    exclude: z.array(z.string()).optional(),
    disable: z.array(z.string()).optional(),
    only: z.array(z.string()).optional(),
    experimental: z.boolean().optional(),
    minSeverity: z.enum(["error", "warn", "info"]).optional(),
  })
  .strict();

export type SpringReviewConfig = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE_NAMES = [".spring-review.json", "spring-review.config.json"];

/**
 * The directories to look in, nearest first: the run directory and its ancestors,
 * stopping after the repository root so a config in `$HOME` or `/` is never picked
 * up by accident.
 *
 * Only looking in the run directory was a gate bug, not a convenience one: in a
 * multi-module repository the team config sits at the root, and `cd backend &&
 * spring-review` — the way most people in that repo run it — honoured none of it.
 * `exclude` and `minSeverity` silently stopped applying, which is the same failure
 * as accepting an invalid config. The *nearest* file wins outright rather than
 * merging upwards, because a merged config is a file nobody wrote.
 */
/** git prints forward slashes even on Windows; `resolve` gives back the platform's. */
function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "") === b.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function configSearchPath(cwd: string, stopAt?: string): string[] {
  const start = resolve(cwd);
  const stop = stopAt ? resolve(stopAt) : undefined;
  const dirs: string[] = [];
  let dir = start;
  for (let guard = 0; guard < 64; guard++) {
    dirs.push(dir);
    if (stop && samePath(dir, stop)) break;
    const parent = dirname(dir);
    if (parent === dir) break; // the filesystem root
    dir = parent;
  }
  return dirs.flatMap((d) => CONFIG_FILE_NAMES.map((n) => join(d, n)));
}

export async function loadConfig(
  cwd: string,
  explicit?: string,
  stopAt?: string,
): Promise<{ config: SpringReviewConfig; path?: string; error?: string }> {
  const candidates = explicit ? [explicit] : configSearchPath(cwd, stopAt);
  for (const candidate of candidates) {
    const raw = await readFile(candidate, "utf8").catch(() => null);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { config: {}, path: candidate, error: `${candidate}: ${(error as Error).message}` };
    }
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      // A strict-mode rejection has no path: its message already names the key.
      return {
        config: {},
        path: candidate,
        error: `${candidate}: ${result.error.issues
          .map((i) => [i.path.join("."), i.message].filter((part) => part).join(" "))
          .join("; ")}`,
      };
    }
    return { config: result.data, path: candidate };
  }
  return { config: {} };
}

export function mergeOptions(
  config: SpringReviewConfig,
  flags: Partial<ReviewOptions>,
): ReviewOptions {
  // Ids are split on commas and whitespace, then upper-cased: `" SPR002 "` and
  // `"SPR002, SPR003"` are how people write a list when the schema says array of
  // string, and accepting them cannot mislead anybody — the rules they name are
  // the rules that get disabled. An id that matches nothing is still refused
  // (see the CLI's `no such rule` check).
  const ids = (list: string[] | undefined) =>
    (list ?? []).flatMap((id) => id.split(/[\s,]+/)).filter(Boolean).map((id) => id.toUpperCase());
  return {
    minSeverity: (flags.minSeverity ?? config.minSeverity ?? "warn") as Severity,
    exclude: [...(config.exclude ?? []), ...(flags.exclude ?? [])],
    experimental: flags.experimental ?? config.experimental ?? false,
    disabledRules: [...ids(config.disable), ...ids(flags.disabledRules)],
    onlyRules: flags.onlyRules ?? ids(config.only),
  };
}
