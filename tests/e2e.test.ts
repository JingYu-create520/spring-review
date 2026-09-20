import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { reviewDiff, reviewPaths } from "../src/index.js";
import type { ReviewOptions } from "../src/types.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (...p: string[]) => readFileSync(join(here, "fixtures", ...p), "utf8");

/**
 * End-to-end over a *real* git repository. This is the only place that proves
 * the whole chain agrees on line numbers: `git diff` → added-line map → file
 * content read from the correct ref → rule → a line a reviewer can click.
 */
let repo: string;
let patchOnlyDir: string;
let shaBaseline = "";
let shaAdded = "";
let shaModified = "";

const JAVA_BAD = "src/main/java/demo/BadUserService.java";
const JAVA_CLEAN = "src/main/java/demo/UserService.java";
const XML_BAD = "src/main/resources/mapper/BadUserMapper.xml";

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "sr-repo-"));
  await git(["init", "-q", "-b", "main"], repo);
  await git(["config", "user.email", "test@example.com"], repo);
  await git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "src/main/java/demo"), { recursive: true });
  await mkdir(join(repo, "src/main/resources/mapper"), { recursive: true });

  // 1 — a clean service plus its mapper interface.
  await writeFile(join(repo, JAVA_CLEAN), fixture("java", "CleanUserService.java").replace("com.example.demo.service", "demo"));
  await writeFile(join(repo, "src/main/java/demo/UserMapper.java"), fixture("java", "UserMapper.java").replace("com.example.demo.mapper", "demo"));
  await writeFile(join(repo, "pom.xml"), "<project/>\n");
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", "chore: baseline"], repo);
  shaBaseline = await git(["rev-parse", "HEAD"], repo);

  // 2 — two brand-new files, full of the things this tool exists to catch.
  await writeFile(join(repo, JAVA_BAD), fixture("java", "BadUserService.java").replace("com.example.demo.service", "demo"));
  await writeFile(join(repo, XML_BAD), fixture("xml", "BadUserMapper.xml").replace(/com\.example\.demo\.mapper/g, "demo"));
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", "feat: user import path"], repo);
  shaAdded = await git(["rev-parse", "HEAD"], repo);

  // 3 — a small edit inside existing files: the diff no longer carries whole files.
  const java = (await readFile(join(repo, JAVA_BAD), "utf8")).replace(
    "    public User rename(Long id, String name) {",
    "    public User rename(Long id, String name) {\n        this.updateName(id, name);",
  );
  await writeFile(join(repo, JAVA_BAD), java);
  const xml = (await readFile(join(repo, XML_BAD), "utf8")).replace(
    "        WHERE status = 1",
    "        WHERE status = 1 AND dept_name = '${deptName}'",
  );
  await writeFile(join(repo, XML_BAD), xml);
  await git(["add", "-A"], repo);
  await git(["commit", "-q", "-m", "fix: filter by dept"], repo);
  shaModified = await git(["rev-parse", "HEAD"], repo);

  // A directory holding only the patch, never the files — the `--patch` case.
  patchOnlyDir = await mkdtemp(join(tmpdir(), "sr-patch-"));
  const patch = await git(["diff", "--no-color", `${shaAdded}..${shaModified}`], repo);
  await writeFile(join(patchOnlyDir, "pr.patch"), patch);
}, 180_000);

const OPTS: ReviewOptions = { minSeverity: "warn", exclude: [], experimental: false };

describe("reviewDiff against a real repository", () => {
  it("finds the Spring pitfalls on the lines the commit added", async () => {
    const result = await reviewDiff(
      { kind: "range", range: `${shaBaseline}..${shaAdded}`, after: shaAdded },
      repo,
      OPTS,
    );

    expect(result.units).toBe(2);
    const rules = new Set(result.findings.map((f) => f.rule));
    for (const expected of ["SPR001", "SPR002", "SPR003", "SPR004", "SPR006", "MYB001", "MYB002"]) {
      expect(rules.has(expected), `expected ${expected} to fire`).toBe(true);
    }
    expect(rules.has("SPR005"), "SPR005 must stay off without --experimental").toBe(false);

    const bad = result.findings.find((f) => f.rule === "SPR001")!;
    const headLines = (await readFile(join(repo, bad.file), "utf8")).split("\n");
    expect(headLines[bad.line - 1]).toContain("this.updateName(id, name);");

    // A file the commit did not touch contributes nothing, even though it is on disk.
    expect(result.findings.some((f) => f.file === JAVA_CLEAN)).toBe(false);
  });

  it("reads content from the reviewed commit, not the working tree", async () => {
    // The work tree now has an extra self-call (commit 3) that commit 2 did not.
    const result = await reviewDiff(
      { kind: "range", range: `${shaBaseline}..${shaAdded}`, after: shaAdded },
      repo,
      OPTS,
    );
    const spr001 = result.findings.filter((f) => f.rule === "SPR001");
    const linesAtAdded = (await git(["show", `${shaAdded}:${JAVA_BAD}`], repo)).split("\n");
    for (const finding of spr001) {
      expect(linesAtAdded[finding.line - 1]).toContain("this.updateName");
    }
    expect(spr001.length).toBe(1);
  });

  it("maps mapper XML findings onto real statement lines", async () => {
    const result = await reviewDiff(
      { kind: "range", range: `${shaBaseline}..${shaAdded}`, after: shaAdded },
      repo,
      OPTS,
    );
    const xml = result.findings.filter((f) => f.file === XML_BAD);
    expect(xml.length).toBeGreaterThan(0);
    const source = (await readFile(join(repo, XML_BAD), "utf8")).split("\n");
    for (const finding of xml) {
      const evidence = source[finding.line - 1] ?? "";
      expect(evidence.trim().length, `${finding.rule} pointed at a blank line`).toBeGreaterThan(0);
      if (finding.rule === "MYB001") expect(evidence).toContain("${");
      if (finding.rule === "MYB004") expect(evidence).toMatch(/\*/);
      if (finding.rule === "MYB003") expect(evidence.toLowerCase()).toContain("%");
    }
    // The companion interface is metadata only: findings never point at it.
    expect(result.findings.some((f) => f.file.endsWith("UserMapper.java"))).toBe(false);
  });

  it("degrades honestly when only the patch is available", async () => {
    const patch = await readFile(join(patchOnlyDir, "pr.patch"), "utf8");
    const result = await reviewDiff({ kind: "patch", text: patch }, patchOnlyDir, OPTS);

    expect(result.units).toBe(2);
    // Token-local judgement survives: `${}` on an added line is unsafe whatever the
    // rest of the file says.
    expect(result.findings.every((f) => f.rule === "MYB001")).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.find((f) => f.rule === "MYB001")!.line).toBeGreaterThan(0);
    // Anything needing the whole statement or the class shape refuses to guess,
    // and records why instead of emitting a plausible-looking false positive.
    expect(result.findings.some((f) => f.rule === "SPR001")).toBe(false);
    expect(result.findings.some((f) => f.rule === "MYB005")).toBe(false);
    expect(result.skipped.some((s) => s.reason.includes("patch fragment"))).toBe(true);
  });

  it("reviewPaths on the clean service yields zero findings", async () => {
    const result = await reviewPaths([JAVA_CLEAN], repo, { ...OPTS, experimental: true });
    expect(result.findings).toEqual([]);
    expect(result.units).toBe(1);
  });

  it("honours excludes on uncommitted changes", async () => {
    await writeFile(join(repo, JAVA_CLEAN), fixture("java", "BadUserService.java").replace("com.example.demo.service", "demo"));
    const excluded = await reviewDiff({ kind: "worktree" }, repo, { ...OPTS, exclude: [JAVA_CLEAN] });
    expect(excluded.findings).toEqual([]);
    expect(excluded.skipped.some((s) => s.reason === "excluded")).toBe(true);

    const included = await reviewDiff({ kind: "worktree" }, repo, OPTS);
    expect(included.findings.length).toBeGreaterThan(0);
    expect(included.findings.every((f) => f.file === JAVA_CLEAN)).toBe(true);

    await git(["checkout", "--", JAVA_CLEAN], repo);
  });

  it("reports nothing for a change that only touches non-reviewable files", async () => {
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(["add", "-A"], repo);
    const result = await reviewDiff({ kind: "staged" }, repo, OPTS);
    expect(result.units).toBe(0);
    expect(result.findings).toEqual([]);
    await git(["reset", "-q", "HEAD", "--", "README.md"], repo);
    await rm(join(repo, "README.md"), { force: true });
  });
});

afterAll(async () => {
  if (process.env["SR_KEEP_TMP"]) {
    process.stdout.write(`kept ${repo}\n(baseline ${shaBaseline}\nadded ${shaAdded}\nmodified ${shaModified})\n`);
    return;
  }
  if (repo) await rm(repo, { recursive: true, force: true });
  if (patchOnlyDir) await rm(patchOnlyDir, { recursive: true, force: true });
});
