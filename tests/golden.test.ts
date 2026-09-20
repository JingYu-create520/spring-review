import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPaths } from "../src/index.js";
import { rules } from "../src/rules/index.js";
import type { Finding } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const goldenPath = join(here, "golden", "demo.json");

/**
 * Golden test: the exact set of (rule, file, line, severity) tuples the demo
 * fixtures produce. Changing a rule's judgement, its line anchor or its severity
 * fails CI with a readable diff, which is what keeps 11 regex/state-machine
 * rules honest as they grow.
 *
 *   UPDATE_GOLDEN=1 npx vitest run tests/golden.test.ts
 */
const projection = (findings: Finding[]) =>
  findings.map((f) => ({
    rule: f.rule,
    file: f.file,
    line: f.line,
    severity: f.severity,
    hasEvidence: f.snippet.trim().length > 0,
    hasFix: typeof f.suggestion === "string" && f.suggestion.length > 0,
  }));

const TARGETS = [
  "java/BadUserService.java",
  "java/CleanUserService.java",
  "xml/BadUserMapper.xml",
];

describe("golden output", () => {
  it("matches the recorded findings for the demo fixtures", async () => {
    const result = await reviewPaths(TARGETS, fixtures, {
      minSeverity: "info",
      exclude: [],
      experimental: true,
    });
    const actual = projection(result.findings);

    if (process.env["UPDATE_GOLDEN"]) {
      await mkdir(dirname(goldenPath), { recursive: true });
      await writeFile(goldenPath, `${JSON.stringify({ targets: TARGETS, findings: actual }, null, 2)}\n`);
      return;
    }

    const golden = JSON.parse(await readFile(goldenPath, "utf8")) as {
      targets: string[];
      findings: ReturnType<typeof projection>;
    };
    expect(actual).toEqual(golden.findings);
  });

  it("every rule in the catalogue fires somewhere across the demo fixtures", async () => {
    const result = await reviewPaths(TARGETS, fixtures, {
      minSeverity: "info",
      exclude: [],
      experimental: true,
    });
    const hit = new Set(result.findings.map((f) => f.rule));
    for (const rule of rules) {
      expect(hit.has(rule.id), `${rule.id} never fires on the demo fixtures`).toBe(true);
    }
  });

  it("the clean service stays silent while the broken one does not", async () => {
    const result = await reviewPaths(TARGETS, fixtures, {
      minSeverity: "info",
      exclude: [],
      experimental: true,
    });
    expect(result.findings.filter((f) => f.file.endsWith("CleanUserService.java"))).toEqual([]);
    expect(result.findings.filter((f) => f.file.endsWith("BadUserService.java")).length).toBeGreaterThan(8);
    // No finding may point outside the file it was found in.
    const sources = new Map<string, string[]>();
    for (const finding of result.findings) {
      const lines = sources.get(finding.file) ?? (await readFile(join(fixtures, finding.file), "utf8")).split("\n");
      sources.set(finding.file, lines);
      expect(finding.line, `${finding.rule} line out of range`).toBeLessThanOrEqual(lines.length);
      expect(finding.line).toBeGreaterThan(0);
    }
  });
});
