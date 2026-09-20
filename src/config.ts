import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function loadConfig(
  cwd: string,
  explicit?: string,
): Promise<{ config: SpringReviewConfig; path?: string; error?: string }> {
  const candidates = explicit ? [explicit] : CONFIG_FILE_NAMES.map((n) => join(cwd, n));
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
      return {
        config: {},
        path: candidate,
        error: `${candidate}: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
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
  return {
    minSeverity: (flags.minSeverity ?? config.minSeverity ?? "warn") as Severity,
    exclude: [...(config.exclude ?? []), ...(flags.exclude ?? [])],
    experimental: flags.experimental ?? config.experimental ?? false,
    disabledRules: [
      ...(config.disable ?? []),
      ...(flags.disabledRules ?? []),
    ].map((r) => r.toUpperCase()),
    onlyRules: flags.onlyRules ?? config.only,
  };
}
