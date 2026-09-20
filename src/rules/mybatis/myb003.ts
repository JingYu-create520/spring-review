import type { Rule } from "../../types.js";
import { draft } from "../util.js";
import { lineAt, scopesFor, type SqlScope } from "../sql.js";

/**
 * MYB003 — leading-wildcard LIKE.
 *
 * `LIKE '%foo%'` cannot use a B-Tree index for the search itself. The detection
 * has to cover how MyBatis code is actually written: a `#{}` placeholder cannot
 * sit inside quotes, so the real-world forms are
 *   like '%xxx%'                       (literal)
 *   like concat('%', #{kw}, '%')        (the common one)
 *   <bind name="kw" value="'%' + p + '%'"/>  (bind, then like #{kw})
 * Missing the CONCAT and `<bind>` shapes — as the original rule sketch did —
 * would make this rule fire on almost nothing.
 */
const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\blike\s*\(?\s*'\s*%/i, why: "LIKE 字面量以 % 开头" },
  { re: /\blike\s*\(?\s*concat\s*\(\s*'%'/i, why: "LIKE concat('%' …) 前置通配" },
  { re: /\bconcat\s*\(\s*'%'\s*,/i, why: "参数被前置 % 包裹" },
  { re: /<bind\b[^>]*value\s*=\s*["']\s*'%'\s*\+/i, why: "<bind> 给参数加了前导 %" },
];

const rule: Rule = {
  id: "MYB003",
  title: "左通配 LIKE 导致索引失效",
  titleEn: "Leading-wildcard LIKE defeats the index",
  severity: "warn",
  target: "both",
  needsFullContext: true,
  rationale:
    "前导 % 让 B-Tree 索引无法用于定位,只能全表/全索引扫描。可改右匹配(前缀检索)、或走全文索引 / ES;必须模糊匹配时至少保证其他高选择性条件先过滤。",
  run({ unit, xml, java }) {
    const out = [];
    const seen = new Set<string>();
    for (const scope of scopesFor({ xml, java })) {
      for (const { re, why } of PATTERNS) {
        const m = new RegExp(re.source, re.flags).exec(scopeText(scope));
        if (!m) continue;
        const line = lineAt(scope.raw, m.index, scope.line);
        const key = `${line}|${why}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          draft(
            rule,
            unit,
            line,
            `${label(scope)} 的 ${why},该条件无法使用索引定位,数据量大时退化为扫描。`,
            `${label(scope)} uses a leading-wildcard LIKE (${why}); the index cannot be used to locate rows.`,
            {
              suggestion:
                "前缀匹配去掉左侧 %(如 LIKE 'abc%' 可走索引);需要真正的子串检索则用全文索引 / ES,并让其他高选择性条件先进 WHERE。",
            },
          ),
        );
      }
    }
    return out;
  },
};

function scopeText(scope: SqlScope): string {
  return scope.source === "xml" ? scope.raw : scope.resolved;
}

function label(scope: SqlScope): string {
  return scope.source === "xml" ? `${scope.kind}#${scope.id}` : "注解 SQL";
}

export default rule;
