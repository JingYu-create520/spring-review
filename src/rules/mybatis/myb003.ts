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

const QUOTED_PLACEHOLDER = /'\s*#\{[^}]*\}\s*'/i;

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
      const text = scopeText(scope);
      // A placeholder inside quotes is not a placeholder: the `?` MyBatis writes
      // ends up inside a string literal, and a driver does not treat that as a
      // parameter — so either nothing binds and the column is compared against
      // literal text, or the binding itself fails. Either way the condition is
      // not the fuzzy match its author meant. Found in a shipping business
      // project (newbee-mall's goods search), which is also why the README's
      // "nobody writes it that way" was wrong. Error, because the query is broken
      // rather than merely slow, and because index advice printed next to it would
      // be the wrong fix. XML only for now: an annotation's offsets differ between
      // `raw` and `resolved`, so the line number could not be trusted there.
      const quoted = QUOTED_PLACEHOLDER.exec(text);
      if (scope.source === "xml" && quoted && /\blike\b/i.test(text)) {
        const line = lineAt(scope.raw, quoted.index, scope.line);
        const key = `${line}|quoted-placeholder`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(
            draft(
              rule,
              unit,
              line,
              `${label(scope)} 把 ${quoted[0]} 写在引号里:引号内的占位符不会被当成参数绑定,这一项要么按字面量比较、要么在设参时报错,不是作者想要的模糊匹配。`,
              `${label(scope)} puts the placeholder inside quotes (${quoted[0]}), so it is not bound as a parameter: the comparison runs against literal text, or the binding fails.`,
              {
                severity: "error",
                suggestion:
                  "去掉引号让参数真正绑定:like CONCAT('%', #{goodsName}, '%')。改完请确认这条查询此前返回的结果是否符合预期。",
              },
            ),
          );
        }
        continue;
      }
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
