import type { Rule } from "../../types.js";
import { draft } from "../util.js";
import { lineAt, scopesFor, type SqlScope } from "../sql.js";

/**
 * MYB001 — SQL injection through `${}`.
 *
 * `${}` is raw text substitution; `#{}` becomes a bound parameter. Anything a
 * caller can influence that reaches `${}` is injectable. Scanned in both mapper
 * XML and `@Select("…")` annotations.
 *
 * Framework placeholders (MyBatis-Plus `${ew.customSqlSegment}`, Generator
 * `${criterion.criteria}`) and `<property>`-bound names are real usages that are
 * not caller-controlled, so they drop to `warn` instead of disappearing — and a
 * dynamic ORDER BY / column name gets a whitelist suggestion rather than
 * "use #{}", which is not actionable there.
 */
/**
 * Placeholders the frameworks themselves emit. These are silent, not downgraded:
 * scanning a real MyBatis Generator project produced 84 warnings for
 * `order by ${orderByClause}` alone, and a rule that fires 84 times on generated
 * code teaches people to ignore the whole tool.
 */
const FRAMEWORK_PLACEHOLDER = [
  /^ew\.\w+$/, // MyBatis-Plus AbstractWrapper: customSqlSegment / sqlSegment / sqlFrom / sqlWhere
  /^criterion\.\w+$/, // MyBatis Generator Example criteria
  /^orderByClause$/, // MyBatis Generator sort clause
  /^distinct$/, // MyBatis Generator SELECT DISTINCT flag
  /^_parameter\.\w+$/,
];

const ORDERISH_FRAGMENT = /^(sort|order|dir|direction|column|field|table|by|asc|desc)/i;
const ORDER_CONTEXT = /(order\s+by|group\s+by|\blimit\b|\boffset\b|\bset\b|from\s*$|select\s+[\w.,*\s]*$)/i;

function boundProperties(raw: string): Set<string> {
  const out = new Set<string>();
  for (const m of raw.matchAll(/<property\s+name=["'](\w+)["']/g)) out.add(m[1] as string);
  return out;
}

const rule: Rule = {
  id: "MYB001",
  title: "SQL 注入（${} 拼接）",
  titleEn: "SQL injection via ${} substitution",
  severity: "error",
  target: "both",
  rationale:
    "${} 直接把值拼进 SQL 文本,#{ } 才会走预编译参数。用户可控值进入 ${} 即构成注入;动态排序/列名要用服务端白名单映射,而不是拼接。",
  run({ unit, xml, java }) {
    const out = [];
    for (const scope of scopesFor({ xml, java })) {
      const bound = boundProperties(scope.raw);
      for (const m of scope.raw.matchAll(/\$\{([^}]*)\}/g)) {
        const fragment = (m[1] ?? "").trim();
        if (!fragment) continue;
        const head = (fragment.split(/[.\s([]/)[0] ?? "").trim();
        if (bound.has(head)) continue;
        const offset = m.index ?? 0;
        const line = lineAt(scope.raw, offset, scope.line);
        const context = scope.raw.slice(Math.max(0, offset - 60), offset + fragment.length + 20);

        if (FRAMEWORK_PLACEHOLDER.some((re) => re.test(fragment))) {
          // Framework contract, not app code. Silent on purpose — see the note on
          // FRAMEWORK_PLACEHOLDER: 84 warnings on one generated project is how a
          // rule set gets ignored wholesale.
          continue;
        }

        const dynamicName = ORDERISH_FRAGMENT.test(head) && ORDER_CONTEXT.test(context);
        // `<include refid="${include_target}"/>` is a documented MyBatis feature:
        // the text comes from a `<property>` or a config file, and what it chooses
        // is a fragment name rather than SQL. One warn, asking where the property
        // comes from — an error there is a false positive on the framework's own
        // example, which is literally what the site documentation contains.
        const includeChoice = /<include\b[^>]*$/.test(scope.raw.slice(0, offset));
        const zh = includeChoice
          ? `${label(scope)} 的 refid 用了 \${${fragment}},它选的是被 include 的片段名,值通常来自 <property> 或配置。确认这条属性没有接到请求参数上。`
          : `${label(scope)} 用 \${${fragment}} 拼接 SQL${dynamicName ? "(动态排序/列名场景)" : ""},该值会原样出现在语句里,存在 SQL 注入风险。`;
        const en = includeChoice
          ? `${label(scope)} chooses its <include> target through \${${fragment}}, so the text comes from a property rather than a parameter.`
          : `${label(scope)} interpolates \${${fragment}} into SQL text instead of binding it.`;
        out.push(
          draft(rule, unit, line, zh, en, {
            severity: dynamicName || includeChoice ? "warn" : "error",
            suggestion: includeChoice
              ? "把该属性固定在构建期(不接受外部输入),或者直接把片段名写出来。"
              : dynamicName
                ? '用服务端白名单映射列名:Map<String,String> SORTABLE = Map.of("name","user_name"),取 SORTABLE.get(param) 拼 SQL,取不到就报错;条件值仍用 #{ }。'
                : `改为预编译参数 #{${head}}。`,
          }),
        );
      }
    }
    return out;
  },
};

function label(scope: SqlScope): string {
  return scope.source === "xml" ? `${scope.kind}#${scope.id}` : `@${scope.kind[0]?.toUpperCase()}${scope.kind.slice(1)} 注解 SQL`;
}

export default rule;
