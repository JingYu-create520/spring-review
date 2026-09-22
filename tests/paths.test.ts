import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPaths } from "../src/index.js";
import { expandReviewInputs } from "../src/diff/collect.js";
import type { ReviewOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const demoRoot = join(here, "..", "examples", "demo-project");
const demoSrc = join("src", "main", "java");

const OPTS: ReviewOptions = { minSeverity: "info", exclude: [], experimental: true };

/** A scratch tree so directory walking can be tested without touching the repo. */
let sandbox = "";
beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "sr-paths-"));
  await mkdir(join(sandbox, "src", "main", "java"), { recursive: true });
  await mkdir(join(sandbox, "src", "test", "java"), { recursive: true });
  await mkdir(join(sandbox, "target", "classes"), { recursive: true });
  await mkdir(join(sandbox, "node_modules", "pkg"), { recursive: true });
  await mkdir(join(sandbox, "notes"), { recursive: true });
  const selfInvoking = `package a;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
@Service class AService { void call() { self(); } @Transactional public void self() {} }
`;
  await writeFile(join(sandbox, "src", "main", "java", "AService.java"), selfInvoking);
  await writeFile(join(sandbox, "src", "test", "java", "AServiceTest.java"), "class AServiceTest {}\n");
  await writeFile(join(sandbox, "target", "classes", "Generated.java"), "class Generated {}\n");
  await writeFile(join(sandbox, "node_modules", "pkg", "Vendor.java"), "class Vendor {}\n");
  await writeFile(join(sandbox, "README.md"), "# not reviewable\n");
  await writeFile(join(sandbox, "notes", "meeting.md"), "# nothing to review here\n");
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("whole-file mode accepts directories and globs, not just single files", () => {
  it("a directory argument reviews the files inside it", async () => {
    const result = await reviewPaths([demoSrc], demoRoot, OPTS);
    expect(result.units).toBeGreaterThanOrEqual(5);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.skipped.filter((s) => s.path === demoSrc)).toHaveLength(0);
  });

  it("the classic mistake — pointing at a source root — no longer reports a clean run", async () => {
    const result = await reviewPaths(["src"], demoRoot, OPTS);
    // Before expansion existed this returned units: 0 and zero findings, which
    // read as "your code is clean".
    expect(result.units).toBeGreaterThan(0);
  });

  it("a glob over a directory expands to matching files", async () => {
    const { files } = await expandReviewInputs(["src/**/*Service.java"], demoRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith("Service.java"))).toBe(true);
    expect(files.every((f) => f.endsWith(".java"))).toBe(true);
  });

  it("a directory that holds nothing reviewable says so instead of passing silently", async () => {
    const { files, skipped } = await expandReviewInputs(["notes"], sandbox);
    expect(files).toHaveLength(0);
    expect(skipped.map((s) => s.path)).toContain("notes");
    expect(skipped[0]?.reason).toMatch(/no \.java\/\.xml file/);
  });

  it("an unreadable path is still named in skipped", async () => {
    const { skipped } = await expandReviewInputs(["does/not/Exist.java"], demoRoot);
    expect(skipped[0]).toMatchObject({ path: "does/not/Exist.java", reason: "not readable" });
  });

  it("skips build output, dependencies and non-source files when walking", async () => {
    const { files } = await expandReviewInputs(["."], sandbox);
    expect(files).toContain(join("src", "main", "java", "AService.java").split("\\").join("/"));
    expect(files.some((f) => f.startsWith("target/"))).toBe(false);
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".md"))).toBe(false);
  });

  it("--exclude prunes files found by the walk", async () => {
    const all = await expandReviewInputs(["src"], sandbox);
    expect(all.files).toHaveLength(2);
    const pruned = await expandReviewInputs(["src"], sandbox, ["**/test/**"]);
    expect(pruned.files).toEqual(["src/main/java/AService.java"]);
  });

  it("overlapping inputs collapse to one unit per file", async () => {
    const viaDir = await reviewPaths(["src"], sandbox, OPTS);
    expect(viaDir.units).toBe(2); // main + test source roots
    const overlapping = await reviewPaths(
      ["src", "src/main/java", "src/main/java/AService.java", "src/main/java/AService.java"],
      sandbox,
      OPTS,
    );
    expect(overlapping.units).toBe(viaDir.units);
    const one = await reviewPaths(["src/main/java/AService.java", "src/main/java/AService.java"], sandbox, OPTS);
    expect(one.units).toBe(1);
    expect(one.findings.map((f) => f.rule)).toContain("SPR001");
  });
});

describe("whole-file mode accepts absolute paths, wherever it was started", () => {
  // `spring-review C:\work\repo\src`, an IDE passing a full path, an agent calling
  // `review_file` with an absolute path and no `cwd` — every one of those joined the
  // absolute path onto the run directory and reported "not readable", which reads
  // like a broken repository rather than a path the tool could not open.
  const elsewhere = join(sandbox, "..", "not-a-repo");

  it("reviews an absolute directory argument", async () => {
    const result = await reviewPaths([join(sandbox, "src")], elsewhere, OPTS);
    expect(result.units).toBe(2);
    expect(result.findings.map((f) => f.rule)).toContain("SPR001");
    expect(
      result.findings.every((f) => f.file.replace(/\\/g, "/").includes("src/main/java/AService.java")),
    ).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it("reviews an absolute single-file argument", async () => {
    const file = join(sandbox, "src", "main", "java", "AService.java");
    const result = await reviewPaths([file], elsewhere, OPTS);
    expect(result.units).toBe(1);
    expect(result.findings[0]?.file).toBe(file.split("\\").join("/"));
  });

  it("keeps relative arguments relative, as before", async () => {
    const result = await reviewPaths(["src/main/java"], sandbox, OPTS);
    expect(result.units).toBe(1);
    expect(result.findings[0]?.file).toBe("src/main/java/AService.java");
  });

  it("expands a glob whose base is absolute", async () => {
    const { files, skipped } = await expandReviewInputs(
      [join(sandbox, "src", "**", "*.java")],
      elsewhere,
    );
    expect(files).toHaveLength(2);
    expect(skipped).toEqual([]);
  });
});
