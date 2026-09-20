import type { LlmProvider, SummaryRequest } from "./provider.js";

/**
 * Deterministic offline summary. This is what runs by default, so the tool
 * needs no API key and produces the same bytes for the same input.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async summarize(request: SummaryRequest): Promise<string> {
    const { findings, hitRules, units } = request;
    if (findings.length === 0) {
      return `Reviewed ${units} changed file(s) against 11 Spring/MyBatis rules — nothing to flag.`;
    }
    const errors = findings.filter((f) => f.severity === "error");
    const top = groupTop(findings);
    const lines = [
      `Reviewed ${units} changed file(s); ${findings.length} finding(s)${errors.length ? `, ${errors.length} of them blocking (error)` : ""}.`,
      "",
      ...top.map(([rule, items]) => {
        const doc = request.ruleDocs[rule];
        const label = doc ? `${rule} (${doc.split(/[。，,.]/)[0]})` : rule;
        const where = items
          .slice(0, 3)
          .map((f) => `${shorten(f.file)}:${f.line}`)
          .join(", ");
        const more = items.length > 3 ? ` +${items.length - 3} more` : "";
        return `- ${label}: ${items.length}×  ${where}${more}`;
      }),
      "",
      errors.length
        ? "建议先处理 error 级问题再合并:事务边界和 SQL 注入在这类改动里最难在 review 里靠肉眼发现。"
        : "没有 error 级问题,可以合并。",
    ];
    void hitRules;
    return lines.join("\n");
  }
}

function groupTop(findings: SummaryRequest["findings"]): Array<[string, SummaryRequest["findings"]]> {
  const map = new Map<string, SummaryRequest["findings"]>();
  for (const f of findings) {
    const list = map.get(f.rule) ?? [];
    list.push(f);
    map.set(f.rule, list);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
}

function shorten(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
