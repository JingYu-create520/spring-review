import type { Rule } from "../../types.js";
import { draft } from "../util.js";
import { hasBoundingClause, isPagedQuery, scopesFor, type SqlScope } from "../sql.js";

/**
 * MYB005 — unbounded SELECT.
 *
 * No WHERE, no LIMIT, and not an aggregate means "load the whole table into the
 * JVM". Pagination that the framework applies (MyBatis-Plus `IPage`/`Page`
 * parameter, PageHelper, RowBounds) is recognised, because the SQL text has no
 * `limit` in that case and reporting it would be a false positive on every
 * paged query in a MyBatis-Plus project — which is most of them.
 */
const AGGREGATE = /\b(count|sum|avg|max|min|group_concat)\s*\(/i;
const EXISTS_ONLY = /\bexists\s*\(|\bnot\s+exists\s*\(/i;

const rule: Rule = {
  id: "MYB005",
  title: "无界全表查询",
  titleEn: "Unbounded full-table scan",
  severity: "error",
  target: "both",
  needsFullContext: true,
  rationale:
    "没有 WHERE 也没有 LIMIT 的 SELECT 会把整张表读进内存。加必要条件和分页;导出场景请走游标/流式查询(fetchSize + ResultHandler)。",
  run({ unit, xml, java, companion }) {
    const out = [];
    for (const scope of scopesFor({ xml, java })) {
      if (scope.kind !== "select") continue;
      const text = scope.resolved;
      if (!/\bfrom\b/i.test(text)) continue; // `<select id="count">` with no table, `select 1`, etc.
      if (hasBoundingClause(scope)) continue;
      if (isPagedQuery(scope, companion)) continue;
      const bare = text.replace(/^\s*select\s+(distinct\s+)?/i, "");
      if (AGGREGATE.test(bare) && !/\bgroup\s+by\b/i.test(text)) continue;
      if (EXISTS_ONLY.test(text) && !/\bfrom\s+\w+\s*$/i.test(text)) continue;
      out.push(
        draft(
          rule,
          unit,
          scope.line,
          `${label(scope)} 既没有 WHERE 条件也没有 LIMIT,会扫描并返回全表数据。`,
          `${label(scope)} has neither a WHERE clause nor a LIMIT, so it reads the whole table.`,
          {
            suggestion:
              "加 WHERE 条件与 LIMIT/分页(MyBatis-Plus 用 IPage 参数);确需全表处理请改成分批游标查询。",
          },
        ),
      );
    }
    return out;
  },
};

function label(scope: SqlScope): string {
  return scope.source === "xml" ? `select#${scope.id}` : "注解 SQL";
}

export default rule;
