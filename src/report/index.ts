import type { Finding, ReviewResult } from "../types.js";

export type ReportFormat = "table" | "json" | "github" | "sarif";

export interface ReportOptions {
  color: boolean;
  /** Text appended after the report; only ever produced by the LLM layer. */
  summary?: string;
  showInfo?: boolean;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function paint(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  error: RED,
  warn: YELLOW,
  info: BLUE,
};

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  error: "error",
  warn: "warn ",
  info: "info ",
};

/** Group findings by file, mirroring how a reviewer reads a diff. */
export function renderTerminal(result: ReviewResult, options: ReportOptions): string {
  const { color } = options;
  const out: string[] = [];
  if (result.findings.length === 0) {
    out.push(
      paint(`✔ spring-review: ${result.units} file(s) reviewed, no findings`, "\x1b[32m", color),
    );
    appendSkipped(out, result, color);
    if (options.summary) out.push("", options.summary.trim());
    return out.join("\n");
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of result.findings) {
    const list = byFile.get(finding.file) ?? [];
    list.push(finding);
    byFile.set(finding.file, list);
  }

  for (const [file, findings] of byFile) {
    out.push("");
    out.push(paint(`${file}`, BOLD + CYAN, color));
    for (const f of findings) {
      out.push(
        `  ${paint(`${f.file}:${f.line}`, DIM, color)}  ${paint(SEVERITY_LABEL[f.severity], SEVERITY_COLOR[f.severity] + BOLD, color)}  ${paint(f.rule, BOLD, color)}  ${f.message}`,
      );
      if (f.snippet) out.push(paint(`      ${oneLine(f.snippet)}`, DIM, color));
      if (f.suggestion) out.push(paint(`      → ${oneLine(f.suggestion)}`, "\x1b[32m", color));
    }
  }

  const errors = result.findings.filter((f) => f.severity === "error").length;
  const warns = result.findings.filter((f) => f.severity === "warn").length;
  const infos = result.findings.filter((f) => f.severity === "info").length;
  out.push("");
  out.push(
    [
      errors ? paint(`${errors} error(s)`, RED + BOLD, color) : null,
      warns ? paint(`${warns} warning(s)`, YELLOW + BOLD, color) : null,
      infos ? paint(`${infos} info`, BLUE, color) : null,
      paint(`across ${byFile.size} file(s), rules hit: ${result.hitRules.join(", ")}`, DIM, color),
    ]
      .filter(Boolean)
      .join("  "),
  );
  appendSkipped(out, result, color);
  if (options.summary) out.push("", paint(prelude(options.color), BOLD, color), options.summary.trim());
  return out.join("\n");
}

function prelude(color: boolean): string {
  return paint("PR summary (LLM-generated; rule findings above are deterministic)", DIM, color);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

function appendSkipped(out: string[], result: ReviewResult, color: boolean): void {
  if (result.skipped.length === 0) return;
  const unique = new Map<string, number>();
  for (const s of result.skipped) {
    const key = `${s.path} — ${s.reason}`;
    unique.set(key, (unique.get(key) ?? 0) + 1);
  }
  out.push("");
  out.push(paint(`skipped (analysis was inconclusive, nothing was guessed):`, DIM, color));
  for (const [key] of unique) out.push(paint(`  ${key}`, DIM, color));
}

export function renderJson(result: ReviewResult): string {
  const payload = {
    tool: "spring-review",
    version: 1,
    summary: {
      units: result.units,
      errors: count(result, "error"),
      warnings: count(result, "warn"),
      infos: count(result, "info"),
      hitRules: result.hitRules,
      skipped: result.skipped,
    },
    findings: result.findings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      file: f.file,
      line: f.line,
      endLine: f.endLine ?? f.line,
      snippet: f.snippet,
      message: f.message,
      messageEn: f.messageEn,
      suggestion: f.suggestion ?? null,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * GitHub Actions annotations. Writing the workflow commands here means the
 * Action is just `spring-review --format github` — no API calls, no comment
 * de-duplication state, and the results still show inline on the diff.
 */
export function renderGithub(result: ReviewResult): string {
  const commands = result.findings.map((f) => {
    // GitHub escapes the parameter list and the message differently: a `:` or a
    // space is only special inside the parameters, and the message is raw text
    // until the end of the line — escaping `:` there would print it literally.
    const data = escapeMessage(f.message.replace(/\s+/g, " "));
    const title = escapeData(`${f.rule} spring-review`);
    return `::${f.severity === "error" ? "error" : f.severity === "warn" ? "warning" : "notice"} file=${escapeData(f.file)},line=${f.line},title=${title}::${data}`;
  });
  const counts = {
    error: count(result, "error"),
    warn: count(result, "warn"),
    info: count(result, "info"),
  };
  commands.push(
    `::notice::${escapeMessage(`spring-review: ${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} info across ${result.units} file(s) [rules: ${result.hitRules.join(" ") || "none"}]`)}`,
  );
  return `${commands.join("\n")}\n`;
}

function escapeData(text: string): string {
  return escapeMessage(text).replace(/:/g, "%3A").replace(/ /g, "%20");
}

/**
 * SARIF 2.1.0 — the format GitHub Code Scanning ingests, so findings become
 * security alerts on the Security tab instead of transient annotations.
 *
 * Rule descriptors come from the rule catalogue, which means `--format sarif`
 * doubles as documentation: a reader on the Security tab sees *why* a pattern is
 * wrong without leaving GitHub.
 */
export function renderSarif(
  result: ReviewResult,
  rules: Array<{ id: string; title: string; titleEn: string; severity: string; rationale: string }>,
  toolVersion: string,
): string {
  const level = (s: Finding["severity"]) => (s === "error" ? "error" : s === "warn" ? "warning" : "note");
  const ruleIndex = new Map(rules.map((r, i) => [r.id, i]));

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "spring-review",
            version: toolVersion,
            informationUri: "https://github.com/JingYu-create520/spring-review",
            rules: rules.map((r) => ({
              id: r.id,
              name: r.titleEn,
              shortDescription: { text: r.titleEn },
              fullDescription: { text: `${r.title} — ${r.rationale}` },
              defaultConfiguration: { level: level(r.severity as Finding["severity"]) },
              properties: { tags: ["spring", "mybatis", "correctness"] },
            })),
          },
        },
        results: result.findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ruleIndex.get(f.rule) ?? 0,
          level: level(f.severity),
          message: {
            text: f.suggestion ? `${f.message}\n${f.suggestion}` : f.message,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
                region: { startLine: f.line, startColumn: 1, snippet: { text: f.snippet } },
              },
            },
          ],
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}

function escapeMessage(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function count(result: ReviewResult, severity: Finding["severity"]): number {
  return result.findings.filter((f) => f.severity === severity).length;
}
