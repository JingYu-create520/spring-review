import { analyzeJava } from "../analyze/java.js";
import { analyzeMapperXml } from "../analyze/xml.js";
import { LineIndex } from "../util/text.js";
import { SEVERITY_RANK, type Finding, type FindingDraft, type JavaFile, type MapperXml, type ReviewOptions, type ReviewResult, type ReviewUnit, type Rule } from "../types.js";
import { collectSuppressions, isSuppressed } from "./suppression.js";

/**
 * Deterministic execution pipeline: analyse once per unit, run the applicable
 * rules, then normalise — fill snippets, drop lines the change did not touch,
 * honour inline suppressions, de-duplicate, filter by severity, sort.
 *
 * No LLM anywhere in here. Same input ⇒ same output, byte for byte.
 */
export function reviewUnits(units: ReviewUnit[], rules: Rule[], options: ReviewOptions): ReviewResult {
  const findings: Finding[] = [];
  const skipped: ReviewResult["skipped"] = [];
  const seen = new Set<string>();

  const disabled = new Set((options.disabledRules ?? []).map((r) => r.toUpperCase()));
  const only = options.onlyRules?.length
    ? new Set(options.onlyRules.map((r) => r.toUpperCase()))
    : undefined;

  for (const unit of units) {
    let java: JavaFile | undefined;
    let xml: MapperXml | undefined;
    let companion: JavaFile | undefined;
    const lines = new LineIndex(unit.content);
    const suppressions = collectSuppressions(lines.lines());
    const structuralIssues: string[] = [];

    if (unit.lang === "java") {
      java = analyzeJava(unit.path, unit.content);
      structuralIssues.push(...java.diagnostics);
    } else if (unit.lang === "xml") {
      xml = analyzeMapperXml(unit.path, unit.content);
      if (xml.diagnostics.some((d) => d.includes("not <mapper>"))) {
        // pom.xml, logback-spring.xml, web.xml …: one line, not one per rule.
        skipped.push({ path: unit.path, reason: "not a MyBatis mapper XML" });
        continue;
      }
      // A mapper that is all `<sql>` fragments is still reviewable: the fragments
      // are scanned where they are written, so only call the file inconclusive
      // when there is no SQL in it at all.
      if (xml.statements.length === 0 && Object.keys(xml.fragments).length === 0) {
        structuralIssues.push(xml.diagnostics.join(" "));
      }
      // Metadata only: `IPage` parameters live in the interface, not the XML.
      if (unit.companion) companion = analyzeJava(unit.companion.path, unit.companion.content);
    }

    for (const rule of rules) {
      const id = rule.id.toUpperCase();
      if (disabled.has(id)) continue;
      if (only && !only.has(id)) continue;
      if (rule.target !== "both" && rule.target !== unit.lang) continue;
      if (rule.experimental && !options.experimental) continue;
      if (rule.needsFullContext && !unit.complete) {
        skipped.push({ path: unit.path, reason: `${rule.id}: file not fully available (patch fragment)` });
        continue;
      }
      // Structure did not parse cleanly ⇒ stay silent rather than guess.
      if (rule.needsFullContext && structuralIssues.length > 0) {
        skipped.push({ path: unit.path, reason: `${rule.id}: ${structuralIssues[0]}` });
        continue;
      }

      let drafts: FindingDraft[];
      try {
        drafts = rule.run({ unit, java, xml, companion, options });
      } catch (error) {
        skipped.push({ path: unit.path, reason: `${rule.id}: ${(error as Error).message}` });
        continue;
      }

      for (const draft of drafts) {
        if (draft.line < 1) continue;
        if (unit.addedLines && !unit.addedLines.has(draft.line)) continue;
        if (isSuppressed(suppressions, draft.rule, draft.line)) continue;
        const key = `${draft.rule}|${draft.file}|${draft.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          ...draft,
          snippet: draft.snippet ?? lines.snippet(draft.line, draft.endLine ?? draft.line),
        });
      }
    }
  }

  const rank = SEVERITY_RANK;
  const kept = findings.filter((f) => rank[f.severity] >= rank[options.minSeverity]);
  kept.sort((a, b) => {
    const bySeverity = rank[b.severity] - rank[a.severity];
    if (bySeverity) return bySeverity;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });

  return {
    findings: kept,
    units: units.length,
    skipped,
    hitRules: [...new Set(kept.map((f) => f.rule))].sort(),
  };
}
