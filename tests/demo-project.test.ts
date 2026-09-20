import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPaths } from "../src/index.js";
import { rules } from "../src/rules/index.js";
import type { ReviewOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const demoRoot = join(here, "..", "examples", "demo-project");
const expected = JSON.parse(readFileSync(join(demoRoot, "expected.json"), "utf8")) as {
  cleanFiles: string[];
  expectedRules: string[];
  minFindings: number;
  maxFindings: number;
};

/** Every .java / .xml under the demo project's source tree. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(java|xml)$/.test(entry)) out.push(relative(demoRoot, full).split(sep).join("/"));
  }
  return out.sort();
}

// Only the source tree: pom.xml is project metadata, not something to review.
const demoSources = sources(join(demoRoot, "src"));

const OPTS: ReviewOptions = { minSeverity: "info", exclude: [], experimental: true };

describe("the demo project is the tool's own proof", () => {
  const files = demoSources;

  it("covers a realistic amount of code, not a toy", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.filter((f) => f.endsWith(".xml"))).toHaveLength(2);
  });

  it("every rule fires somewhere on realistic business code", async () => {
    const result = await reviewPaths(files, demoRoot, OPTS);
    const hit = new Set(result.findings.map((f) => f.rule));

    // The catalogue and the expectation file must agree, so adding a rule without
    // teaching the demo to trigger it fails here.
    expect(new Set(rules.map((r) => r.id))).toEqual(new Set(expected.expectedRules));
    for (const id of expected.expectedRules) {
      expect(hit.has(id), `${id} does not fire on the demo project`).toBe(true);
    }
  });

  it("the files written the right way stay silent", async () => {
    const result = await reviewPaths(files, demoRoot, OPTS);
    for (const clean of expected.cleanFiles) {
      const findings = result.findings.filter((f) => f.file === clean);
      expect(findings.map((f) => `${f.rule}:${f.line}`), `${clean} should be clean`).toEqual([]);
    }
  });

  it("keeps the total in a sane band so neither rot nor over-reporting slips in", async () => {
    const result = await reviewPaths(files, demoRoot, OPTS);
    expect(result.findings.length).toBeGreaterThanOrEqual(expected.minFindings);
    expect(result.findings.length).toBeLessThanOrEqual(expected.maxFindings);
    // Nothing may be reported outside the demo tree, and every line must exist.
    for (const finding of result.findings) {
      expect(finding.file.startsWith("src/"), finding.file).toBe(true);
      const lines = readFileSync(join(demoRoot, finding.file), "utf8").split("\n");
      expect(finding.line, `${finding.file} line out of range`).toBeLessThanOrEqual(lines.length);
      expect(lines[finding.line - 1]!.trim().length, `${finding.file}:${finding.line} is blank`).toBeGreaterThan(0);
    }
  });

  it("without --experimental the singleton-state rule stays off, as documented", async () => {
    const result = await reviewPaths(files, demoRoot, { ...OPTS, experimental: false });
    expect(result.findings.some((f) => f.rule === "SPR005")).toBe(false);
  });
});
