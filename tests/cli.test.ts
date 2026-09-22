import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.js";
import { listRules } from "../src/rules/index.js";
import { renderGithub, renderJson, renderSarif, renderTerminal } from "../src/report/index.js";
import { rules } from "../src/rules/index.js";
import { PACKAGE_VERSION } from "../src/version.js";
import type { ReviewResult } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(["node", "spring-review", ...args], {
    stdout: (chunk) => {
      out += chunk;
    },
    stderr: (chunk) => {
      err += chunk;
    },
    isTTY: false,
  });
  return { code, out, err };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("CLI", () => {
  it("--version matches src/version.ts and package.json", async () => {
    const pkg = JSON.parse(await readFile(resolve(here, "..", "package.json"), "utf8"));
    expect(PACKAGE_VERSION).toBe(pkg.version);
    const { out, code } = await cli("--version");
    expect(out.trim()).toBe(PACKAGE_VERSION);
    expect(code).toBe(0);
  });

  it("--list-rules returns all 11 rules with bilingual titles", async () => {
    const { out, code } = await cli("--list-rules");
    expect(code).toBe(0);
    const docs = JSON.parse(out) as ReturnType<typeof listRules>;
    expect(docs).toHaveLength(11);
    expect(docs.map((d) => d.id)).toEqual([
      "SPR001", "SPR002", "SPR003", "SPR004", "SPR005", "SPR006",
      "MYB001", "MYB002", "MYB003", "MYB004", "MYB005",
    ]);
    for (const doc of docs) {
      expect(doc.title.length, doc.id).toBeGreaterThan(0);
      expect(doc.titleEn.length, doc.id).toBeGreaterThan(0);
      expect(doc.rationale.length, doc.id).toBeGreaterThan(20);
    }
  });

  it("whole-file mode exits 1 when errors are found and prints evidence", async () => {
    const { out, code } = await cli("--cwd", fixtures, "--file", "java/BadUserService.java");
    expect(code).toBe(1);
    expect(out).toContain("SPR001");
    expect(out).toContain("this.updateName(id, name);");
    expect(out).toContain("error(s)");
  });

  it("--min-severity error drops warnings from both the report and the exit code", async () => {
    const { out } = await cli("--cwd", fixtures, "--file", "java/BadUserService.java", "--min-severity", "error");
    expect(out).not.toContain("warn ");
    const clean = await cli("--cwd", fixtures, "--file", "java/CleanUserService.java");
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("no findings");
  });

  it("--format json is stable, and --llm cannot change a single finding byte", async () => {
    const plain = await cli("--cwd", fixtures, "--file", "java/BadUserService.java", "--format", "json");
    const withLlm = await cli("--cwd", fixtures, "--file", "java/BadUserService.java", "--format", "json", "--llm");
    expect(plain.code).toBe(1);
    // The LLM layer is prose only: the machine-readable result must not move.
    expect(digest(withLlm.out)).toBe(digest(plain.out));
    const payload = JSON.parse(plain.out) as ReviewResult & { summary: { errors: number } };
    expect(payload.findings.every((f) => f.snippet.length > 0)).toBe(true);
    expect(payload.findings.every((f) => f.line >= 1)).toBe(true);
  });

  it("--llm adds an offline summary without any network or key", async () => {
    const { out, code } = await cli("--cwd", fixtures, "--file", "java/BadUserService.java", "--llm");
    expect(code).toBe(1);
    expect(out).toContain("Reviewed");
    expect(out).toContain("PR summary");
  });

  it("an unreachable LLM endpoint degrades instead of failing the run", async () => {
    process.env["SR_LLM_BASE_URL"] = "http://127.0.0.1:1/v1";
    process.env["SR_LLM_API_KEY"] = "test";
    try {
      const { out, code } = await cli("--cwd", fixtures, "--file", "java/BadUserService.java", "--llm");
      expect(code).toBe(1);
      expect(out).toContain("LLM 总结不可用");
    } finally {
      delete process.env["SR_LLM_BASE_URL"];
      delete process.env["SR_LLM_API_KEY"];
    }
  });

  it("--disable and a .spring-review.json config both silence rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-cli-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "src", "S.java"),
        [
          "class S {",
          "  void a() { this.b(); }",
          "  @Transactional void b() {}",
          "}",
          "",
        ].join("\n"),
      );
      const before = await cli("--cwd", dir, "--file", "src/S.java");
      expect(before.out).toContain("SPR001");

      const flag = await cli("--cwd", dir, "--file", "src/S.java", "--disable", "SPR001");
      expect(flag.out).not.toContain("SPR001");

      await writeFile(join(dir, ".spring-review.json"), JSON.stringify({ disable: ["SPR001"] }));
      const configured = await cli("--cwd", dir, "--file", "src/S.java");
      expect(configured.out).not.toContain("SPR001");
      expect(configured.code).toBe(0);

      // Reading the config wrong is not a licence to enforce something else than
      // the repository asked for: `disable` and `exclude` are what the gate is.
      await writeFile(join(dir, ".spring-review.json"), "{ not json");
      const broken = await cli("--cwd", dir, "--file", "src/S.java");
      expect(broken.code).toBe(2);
      expect(broken.err).toContain("invalid config");
      expect(broken.out).not.toContain("SPR001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown format with exit code 2", async () => {
    const { err, code } = await cli("--format", "yaml");
    expect(code).toBe(2);
    expect(err).toContain("unknown --format");
  });

  it("says so when run outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-nogit-"));
    try {
      const { err, code } = await cli("--cwd", dir);
      expect(code).toBe(2);
      expect(err).toMatch(/not a git repository|--patch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI refuses input it cannot honour", () => {
  /** A directory with one error-severity file in it, plus an optional config. */
  async function workspace(config?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "sr-cli-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "ApiService.java"),
      [
        "package demo;",
        "import org.springframework.stereotype.Service;",
        "import org.springframework.transaction.annotation.Transactional;",
        "@Service",
        "public class ApiService {",
        "    @Transactional",
        '    public void commit() throws java.io.IOException {',
        '        throw new java.io.IOException("x");',
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    if (config !== undefined) await writeFile(join(dir, ".spring-review.json"), config);
    return dir;
  }

  it("an unknown --min-severity is a usage error, not a clean run", async () => {
    // Comparing against a level that exists nowhere filtered every finding out,
    // so a typo made the gate pass with exit 0 and "no findings".
    const dir = await workspace();
    const bad = await cli("--cwd", dir, "--file", "src", "--min-severity", "high");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown --min-severity "high"');
    expect(bad.out).not.toContain("no findings");

    // Case is a typo, not a lie: `WARN` means warn.
    const cased = await cli("--cwd", dir, "--file", "src", "--min-severity", "ERROR");
    expect(cased.code).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("a --disable id that matches no rule is an error", async () => {
    const dir = await workspace();
    const { code, err } = await cli("--cwd", dir, "--file", "src", "--disable", "SPR5");
    expect(code).toBe(2);
    expect(err).toContain("no such rule: SPR5");
    // The valid spelling still just works.
    const ok = await cli("--cwd", dir, "--file", "src", "--disable", "spr002");
    expect(ok.code).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("a broken .spring-review.json stops the run instead of being ignored", async () => {
    const dir = await workspace('{"disables":["SPR001"],"exclude":123}');
    const { code, err } = await cli("--cwd", dir, "--file", "src");
    expect(code).toBe(2);
    expect(err).toContain(".spring-review.json");
    expect(err).toContain("Unrecognized key(s)");
    expect(err).toContain("exclude Expected array");
    // The strict-mode rejection has no path, and used to render as `:  Unrecognized`.
    expect(err).not.toContain(":  ");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("report renderers", () => {
  const sample: ReviewResult = {
    units: 1,
    hitRules: ["MYB001"],
    skipped: [{ path: "X.java", reason: "no added lines" }],
    findings: [
      {
        rule: "MYB001",
        severity: "error",
        file: "a/b/Mapper.xml",
        line: 7,
        snippet: "WHERE name = '${x}'",
        message: '存在注入风险: uses "quoted" 100% ok',
        messageEn: "interpolates ${x}",
      },
    ],
  };

  it("github format escapes only what GitHub requires", () => {
    const out = renderGithub(sample);
    expect(out).toContain("::error file=a/b/Mapper.xml,line=7,title=MYB001%20spring-review::");
    expect(out).toContain("100%25 ok");
    // A colon in the message must survive as a colon, not %3A.
    expect(out).toContain("存在注入风险: uses");
    expect(out).toContain("::notice::spring-review: 1 error(s)");
  });

  it("json format carries the summary and every field a consumer needs", () => {
    const payload = JSON.parse(renderJson(sample)) as Record<string, unknown>;
    expect(payload["tool"]).toBe("spring-review");
    expect((payload["summary"] as { errors: number }).errors).toBe(1);
    expect((payload["findings"] as unknown[]).length).toBe(1);
  });

  it("terminal format stays readable with colour off and mentions skips", () => {
    const plain = renderTerminal(sample, { color: false });
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("MYB001");
    expect(plain).toContain("skipped");
    const clean = renderTerminal(
      { units: 2, hitRules: [], skipped: [], findings: [] },
      { color: false },
    );
    expect(clean).toContain("no findings");
  });

  it("sarif format is ingestable by GitHub code scanning", () => {
    const catalogue = rules.map((r) => ({
      id: r.id,
      title: r.title,
      titleEn: r.titleEn,
      severity: r.severity,
      rationale: r.rationale,
    }));
    const sarif = JSON.parse(renderSarif(sample, catalogue, "0.1.0")) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string; rules: Array<{ id: string; fullDescription: { text: string }; defaultConfiguration: { level: string } }> } };
        results: Array<{
          ruleId: string;
          ruleIndex: number;
          level: string;
          message: { text: string };
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
        }>;
      }>;
    };

    expect(sarif.version).toBe("2.1.0");
    const run = sarif.runs[0]!;
    expect(run.tool.driver.name).toBe("spring-review");
    // Every rule must be declared so the Security tab can explain itself.
    expect(run.tool.driver.rules).toHaveLength(11);
    expect(run.tool.driver.rules.every((r) => r.fullDescription.text.includes("—"))).toBe(true);

    const result = run.results[0]!;
    expect(result.ruleId).toBe("MYB001");
    expect(result.level).toBe("error"); // error → error, not "warn"
    expect(result.ruleIndex).toBe(run.tool.driver.rules.findIndex((r) => r.id === "MYB001"));
    expect(result.locations[0]!.physicalLocation.artifactLocation.uri).toBe("a/b/Mapper.xml");
    expect(result.locations[0]!.physicalLocation.region.startLine).toBe(7);
    expect(result.message.text).toContain("存在注入风险");
  });

  it("warn maps to SARIF warning and info to note", () => {
    const catalogue = [{ id: "SPR005", title: "t", titleEn: "e", severity: "warn", rationale: "r" }];
    const forSeverity = (severity: "warn" | "info") =>
      JSON.parse(
        renderSarif(
          { ...sample, findings: [{ ...sample.findings[0]!, rule: "SPR005", severity }] },
          catalogue,
          "0.1.0",
        ),
      ).runs[0].results[0].level;
    expect(forSeverity("warn")).toBe("warning");
    expect(forSeverity("info")).toBe("note");
  });
});
