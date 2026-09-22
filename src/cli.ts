import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { reviewDiff, reviewPaths } from "./index.js";
import { listRules, rules as allRules } from "./rules/index.js";
import { loadConfig, mergeOptions } from "./config.js";
import { MockProvider, providerFromEnv } from "./llm/provider.js";
import { renderGithub, renderJson, renderSarif, renderTerminal, type ReportFormat } from "./report/index.js";
import type { Severity } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const FORMATS = new Set<ReportFormat>(["table", "json", "github", "sarif"]);
const SEVERITIES = new Set<Severity>(["error", "warn", "info"]);

export interface CliIo {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  isTTY?: boolean;
}

/**
 * Exit codes are the CI contract:
 *   0 nothing blocking, 1 at least one `error` finding, 2 the tool could not run.
 * `warn` never fails a build — that is what makes the rule set safe to widen.
 */
export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const write = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const fail = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  // `spring-review mcp` is the form MCP client configs invoke, so it has to be
  // handled before option parsing: the server owns stdout from here on.
  if (argv[2] === "mcp" || argv.includes("--mcp")) {
    const { startStdio } = await import("./mcp/index.js");
    await startStdio();
    return 0;
  }

  const program = new Command();
  program
    .name("spring-review")
    .exitOverride()
    .configureOutput({
      // Route commander's own output (help, version, parse errors) through the
      // injected streams so the CLI stays testable and honours --no-color.
      writeOut: (text) => write(text),
      writeErr: (text) => fail(text),
    })
    .description(
      "Offline-first code review for Spring & MyBatis: git diff in, line-level findings out.",
    )
    .version(PACKAGE_VERSION)
    .argument("[paths...]", "review these files in whole-file mode")
    .option("--diff <range>", "review `git diff <range>`, e.g. HEAD~1..HEAD")
    .option("--staged", "review staged changes (git diff --cached)")
    .option("--patch <file>", "read a unified diff from a file instead of git")
    .option("--file <path...>", "review whole files (every line reportable)")
    .option("--format <fmt>", "table | json | github | sarif", "table")
    .option("--min-severity <sev>", "error | warn | info (default warn)")
    .option("--exclude <glob...>", "paths to skip, e.g. '**/generated/**'")
    .option("--disable <rule...>", "turn rules off by id")
    .option("--experimental", "include experimental rules (SPR005)")
    .option("--llm", "append a PR-style summary (SR_LLM_* env, else offline template)")
    .option("--summary-only", "print only that summary")
    .option("--config <file>", "config file (default .spring-review.json)")
    .option("--cwd <dir>", "repository root to run against", process.cwd())
    .option("--no-color", "disable ANSI colours")
    .option("--list-rules", "print the rule catalogue as JSON and exit")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  spring-review                          # uncommitted changes",
        "  spring-review --diff HEAD~1..HEAD      # a commit range",
        "  spring-review --patch pr.patch --format github",
        "  spring-review --file src/main/java/demo/UserService.java",
        "",
        `Environment: ${"SR_LLM_BASE_URL"} / SR_LLM_API_KEY / SR_LLM_MODEL`,
      ].join("\n"),
    );

  try {
    program.parse(argv);
  } catch (error) {
    const code = (error as { exitCode?: number }).exitCode;
    // --help / --version are successes; anything else is a usage error.
    return code === 0 ? 0 : 2;
  }
  const opts = program.opts<Record<string, string | string[] | boolean | undefined>>();

  if (opts["listRules"]) {
    write(`${JSON.stringify(listRules(), null, 2)}\n`);
    return 0;
  }

  const format = String(opts["format"] ?? "table") as ReportFormat;
  if (!FORMATS.has(format)) {
    fail(`spring-review: unknown --format "${format}" (expected table | json | github | sarif)\n`);
    return 2;
  }

  const cwd = String(opts["cwd"] ?? process.cwd());
  const { config, error: configError } = await loadConfig(cwd, opts["config"] as string | undefined);
  if (configError) {
    // Not "ignoring invalid config". `disable` and `exclude` are how a team makes
    // this gate livable, so a file that is quietly discarded changes what the
    // build enforces without anyone deciding that — the same failure as a flag
    // typo that turns the run clean.
    fail(`spring-review: invalid config — ${configError}\n`);
    return 2;
  }

  // Case-insensitive, because `WARN` is what someone types at 6pm. An
  // unrecognised level must not fall through to "nothing matches", which is what
  // comparing against an unknown rank used to do: exit 0, "no findings".
  const rawSeverity = opts["minSeverity"] as string | undefined;
  const minSeverity = rawSeverity?.trim().toLowerCase() as Severity | undefined;
  if (rawSeverity !== undefined && !SEVERITIES.has(minSeverity as Severity)) {
    fail(
      `spring-review: unknown --min-severity "${rawSeverity}" (expected error | warn | info)\n`,
    );
    return 2;
  }

  const options = mergeOptions(config, {
    minSeverity,
    exclude: (opts["exclude"] as string[] | undefined) ?? [],
    disabledRules: (opts["disable"] as string[] | undefined) ?? [],
    experimental: Boolean(opts["experimental"]),
  });

  // A rule id that matches nothing is not a no-op, it is a wrong expectation:
  // `--disable SPR5` reads as "this repo turned that rule off" while the rule
  // keeps firing. Both the config file and the flags go through here.
  const known = new Set(allRules.map((r) => r.id.toUpperCase()));
  const unknownRules = [...(options.disabledRules ?? []), ...(options.onlyRules ?? [])].filter(
    (id) => !known.has(id.toUpperCase()),
  );
  if (unknownRules.length > 0) {
    fail(
      `spring-review: no such rule: ${unknownRules.join(", ")} (see --list-rules)\n` +
        `spring-review: rules are ${[...known].join(", ")}\n`,
    );
    return 2;
  }

  const wholeFiles = [
    ...program.args,
    ...((opts["file"] as string[] | undefined) ?? []),
  ];

  let result;
  try {
    if (opts["patch"]) {
      const text = await readFile(String(opts["patch"]), "utf8");
      result = await reviewDiff({ kind: "patch", text }, cwd, options);
    } else if (wholeFiles.length > 0 && !opts["diff"] && !opts["staged"]) {
      result = await reviewPaths(wholeFiles, cwd, options);
    } else if (opts["diff"]) {
      const range = String(opts["diff"]);
      const [before, after] = range.split("..");
      // `A..B` ⇒ content comes from B. `HEAD~1` alone ⇒ git compares that commit
      // with the working tree, so content must come from the working tree.
      result = await reviewDiff(
        after !== undefined
          ? { kind: "range", range, after: after || "HEAD" }
          : { kind: "range", range },
        cwd,
        options,
      );
    } else if (opts["staged"]) {
      result = await reviewDiff({ kind: "staged" }, cwd, options);
    } else {
      result = await reviewDiff({ kind: "worktree" }, cwd, options);
    }
  } catch (error) {
    fail(`spring-review: ${(error as Error).message}\n`);
    return 2;
  }

  const repoProblem = result.skipped.find((s) => /not a git repository|git diff failed/.test(s.reason));
  if (repoProblem && result.units === 0) {
    fail(`spring-review: ${repoProblem.reason}\n`);
    return 2;
  }

  const summaryRequested = Boolean(opts["llm"] || opts["summaryOnly"]);
  let summary: string | undefined;
  if (summaryRequested) {
    const provider = providerFromEnv() ?? new MockProvider();
    summary = await provider.summarize({
      findings: result.findings,
      hitRules: result.hitRules,
      units: result.units,
      ruleDocs: Object.fromEntries(allRules.map((r) => [r.id, r.rationale])),
    });
  }

  if (opts["summaryOnly"]) {
    write(`${(summary ?? "").trim()}\n`);
    return 0;
  }

  if (format === "json") write(renderJson(result));
  else if (format === "github") write(renderGithub(result));
  else if (format === "sarif")
    write(
      renderSarif(
        result,
        allRules.map((r) => ({
          id: r.id,
          title: r.title,
          titleEn: r.titleEn,
          severity: r.severity,
          rationale: r.rationale,
        })),
        PACKAGE_VERSION,
      ),
    );
  else {
    write(
      renderTerminal(result, {
        color: opts["color"] !== false && (io.isTTY ?? process.stdout.isTTY) === true,
        summary,
      }),
    );
    write("\n");
  }

  return result.findings.some((f) => f.severity === "error") ? 1 : 0;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`spring-review: fatal: ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 2;
    });
}
