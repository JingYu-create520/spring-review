import type { Rule } from "../../types.js";
import { draft } from "../util.js";
import { lineAt, scopesFor, type SqlScope } from "../sql.js";

/**
 * MYB004 — `SELECT *`.
 *
 * Fetches every column, so the covering-index path disappears, network and
 * deserialization cost grows with the table, and adding a column silently
 * changes what the mapper returns. `count(*)` and `exists(select 1)` must not
 * match, which is why the pattern is anchored to the position right after the
 * `select` keyword.
 */
const STAR = /\bselect\s+(?:distinct\s+)?(?:`?\w+`?\s*\.\s*)?\*/i;
const AGGREGATE_ONLY = /^\s*select\s+(?:distinct\s+)?(?:count|sum|avg|max|min|group_concat|json_arrayagg|json_objectagg)\s*\(/i;

const rule: Rule = {
  id: "MYB004",
  title: "SELECT * 取全部列",
  titleEn: "SELECT * returns every column",
  severity: "warn",
  target: "both",
  needsFullContext: true,
  rationale:
    "SELECT * 让覆盖索引失效、多拉无用列,表结构一变返回就变。列出真正需要的列(MyBatis 里可配 <sql id=\"Base_Column_List\"> 复用)。",
  run({ unit, xml, java }) {
    const out = [];
    for (const scope of scopesFor({ xml, java })) {
      if (scope.kind !== "select") continue;
      const text = scope.resolved;
      if (AGGREGATE_ONLY.test(text)) continue;
      const m = STAR.exec(text);
      if (!m) continue;
      out.push(
        draft(
          rule,
          unit,
          selectLine(scope, text),
          `${label(scope)} 使用 SELECT *,会取回不需要的列并使覆盖索引无法使用。`,
          `${label(scope)} selects every column, defeating covering indexes and widening the payload.`,
          { suggestion: "列出需要的列,并抽成 <sql id=\"Base_Column_List\"> 供多处 <include> 复用。" },
        ),
      );
    }
    return out;
  },
};

function selectLine(scope: SqlScope, text: string): number {
  const m = STAR.exec(scope.raw);
  if (!m) return scope.line;
  return lineAt(scope.raw, m.index, scope.line);
}

function label(scope: SqlScope): string {
  return scope.source === "xml" ? `${scope.kind}#${scope.id}` : "注解 SQL";
}

export default rule;
