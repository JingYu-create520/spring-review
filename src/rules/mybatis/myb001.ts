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
 * The advice has to match the *position* the placeholder occupies. A bound
 * parameter can only replace one value inside an expression, so telling someone
 * to write `#{}` for a sort column, a table name, a column name or a whole
 * injected WHERE clause is not a fix — it is broken SQL, and the reader learns
 * that the tool does not know what it is looking at. Position comes from the
 * text around the placeholder on its own line, and the shapes it has to tell
 * apart are all real: `${params.dataScope}` (a data-scope aspect's WHERE
 * fragment) and `${sql}` (a generator's whole DDL statement) in a widely
 * deployed admin framework; `from ${table}`, `select ${id} as id`,
 * `col_${suffix}`, `${key} = #{item}` and `<if test="'${value}' == 'x'">` in
 * MyBatis' own test corpus. The old build recommended `#{}` for every one of
 * them, and for `${params.dataScope}` it recommended `#{params}` — a Map handed
 * to the driver.
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

/** A placeholder that is the whole content of its element: markup either side, nothing else. */
const ONLY_MARKUP = /^(?:<[^>]*>|[\s])*$/;
/** Sorted or grouped by, possibly the second item of a list. */
const CLAUSE_BEFORE = /\b(?:order|group)\s+by\s+[\w.,*\s]*(?:(?:asc|desc)\s*)?$/i;
/** Glued to an identifier with no space between: `col_${suffix}`, `${prefix}_id`. */
const GLUED_BEFORE = /[\w$]$/;
const GLUED_AFTER = /^[\w$]/;
/** Something that must be an identifier follows: `${key} = #{item}`. */
const COMPARED_AFTER = /^\s*(?:=|!=|<>|>=|<=|<|>|\blike\b|\bin\b|\bbetween\b)/i;
/** Select list position: `select ${id} as id from t`. */
const SELECT_LIST = /\b(?:select|distinct)\b[\s\w.,*]*$/i;
/** An object name in place of an identifier: `from ${table}`, `update ${t}`. */
const OBJECT_BEFORE = /\b(?:from|join|into|update|table|index|sequence)\b[\s\w.,]*$/i;
/** Somewhere a bound parameter really can go. `%` covers `like '%${kw}%'`. */
const VALUE_BEFORE = /(['"%=<>!(,]|\b(?:like|in|and|or|set|values|limit|offset|when|then|else|using|having)\b\s*)$/i;
/** `params.dataScope` binds; `list.size()` and `@Foo@bar("x")` do not. */
const BINDABLE_PATH = /^[\w$]+(?:\.[\w$]+)*$/;

type Position = "include" | "clause" | "fragment" | "attribute" | "identifier" | "value";

function positionOf(raw: string, offset: number, matched: string): Position {
  const lineStart = raw.lastIndexOf("\n", offset) + 1;
  let lineEnd = raw.indexOf("\n", offset);
  if (lineEnd < 0) lineEnd = raw.length;
  const nearBefore = raw.slice(lineStart, offset);
  const nearAfter = raw.slice(offset + matched.length, lineEnd);
  const before = nearBefore.trimEnd();
  const after = nearAfter.trim();
  // SQL wraps. When a placeholder starts its own line, the text that decides its
  // role is on the line above — `values(` then a newline then `${id}` is a value,
  // while a bare `${params.dataScope}` under a `<where>` is not.
  const prevTail = before === "" ? raw.slice(0, lineStart).trimEnd().slice(-80) : "";

  if (/<include\b[^>]*$/i.test(before)) return "include";
  if (CLAUSE_BEFORE.test(before)) return "clause";
  // Markup either side is tested before the value pattern, because
  // `<where>${scope}</where>` ends in `>` just like a comparison does — and it is
  // the condition, not a value.
  if (ONLY_MARKUP.test(before) && ONLY_MARKUP.test(after)) return "fragment";
  // Inside a tag attribute: an open tag whose last quote is still open, so the
  // placeholder lands in `test="…"` / `value="…"` rather than in the SQL. Quote
  // parity over the whole attribute list does not work — `<if test="` already
  // carries one delimiter — so look at what directly precedes the placeholder.
  const tagStart = before.lastIndexOf("<");
  if (
    tagStart >= 0 &&
    !before.slice(tagStart).includes(">") &&
    /["']$/.test(before)
  ) {
    return "attribute";
  }
  // Identifier tests come before the value test: a tag ends in `>`, and so does a
  // comparison operator, but `<foreach …>${key} = #{item}` interpolates a column
  // name, and `#{key}` there does not bind a column. Glue is read from the
  // untrimmed neighbours — `= ${pageSize} limit` is a value, `col_${suffix}` is
  // half a column name, and the difference is the space.
  if (COMPARED_AFTER.test(after)) return "identifier";
  if (GLUED_BEFORE.test(nearBefore) || GLUED_AFTER.test(nearAfter)) return "identifier";
  if (OBJECT_BEFORE.test(before) || SELECT_LIST.test(before)) return "identifier";
  if (VALUE_BEFORE.test(before) || (prevTail !== "" && VALUE_BEFORE.test(prevTail))) return "value";
  // Nothing in the line says where this goes. Say what it is (raw text in SQL)
  // and give the position-neutral advice rather than guessing `#{}`.
  return "fragment";
}

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

        // `#{ids[${index}]}` — the foreach index picks *which parameter* to bind,
        // and the text never reaches the SQL string. MyBatis' own test corpus does
        // this; flagging it would be flagging a bound parameter as injection.
        const openBinding = scope.raw.lastIndexOf("#{", offset);
        if (openBinding >= 0 && !scope.raw.slice(openBinding + 2, offset).includes("}")) continue;

        const position = positionOf(scope.raw, offset, m[0]);
        // `<include refid="${include_target}"/>` is a documented MyBatis feature:
        // the text comes from a `<property>` or a config file, and what it chooses
        // is a fragment name rather than SQL. One warn, asking where the property
        // comes from — an error there is a false positive on the framework's own
        // example, which is literally what the site documentation contains.
        const includeChoice = position === "include";
        // A dynamic sort/column name stays a warn: it is the one `${}` usage that
        // framework-generated mappers write on purpose, and the fix (a whitelist
        // map) is a design change rather than a dropped `#`.
        const dynamicName = ORDERISH_FRAGMENT.test(head) && ORDER_CONTEXT.test(context);

        const severity: "error" | "warn" = dynamicName || includeChoice ? "warn" : "error";
        let zh: string;
        let en: string;
        let suggestion: string;

        if (includeChoice) {
          zh = `${label(scope)} 的 refid 用了 \${${fragment}},它选的是被 include 的片段名,值通常来自 <property> 或配置。确认这条属性没有接到请求参数上。`;
          en = `${label(scope)} chooses its <include> target through \${${fragment}}, so the text comes from a property rather than a parameter.`;
          suggestion = "把该属性固定在构建期(不接受外部输入),或者直接把片段名写出来。";
        } else if (position === "attribute") {
          // `<if test="'${value}' == 'x'">` and `<property value="${var}"/>`
          // substitute into the tag's own text — an OGNL expression or a property
          // default — before the SQL is ever built, so `#{}` is not on the menu.
          zh = `${label(scope)} 的动态标签属性里用了 \${${fragment}}:替换的是标签属性文本(OGNL 表达式或属性默认值),不是 SQL 里的值。`;
          en = `${label(scope)} interpolates \${${fragment}} into a dynamic tag attribute, so the text becomes part of an OGNL expression or property default rather than a SQL value.`;
          suggestion =
            '属性里的拼接不经过预编译,#{ } 也救不了:让 test/of 直接判断入参本身(test="x != null"),确实需要动态属性名时用服务端白名单把值映射死。';
        } else if (position === "fragment") {
          // `${params.dataScope}` on its own line, or `${sql}` as the entire body
          // of an `<update>`: the value *is* SQL text. Nothing here becomes a
          // bound parameter, so the message names the only real control point.
          zh = `${label(scope)} 用 \${${fragment}} 拼入一整段 SQL 片段(条件、子句或语句本身),不是拼接一个值。`;
          en = `${label(scope)} interpolates \${${fragment}} as an entire SQL fragment rather than as one value.`;
          suggestion = `这个位置换不成 #{ }:预编译参数只能替代表达式里的值,替代不了一段 SQL。控制点只能在服务端——确认 \${${fragment}} 的来源(数据权限切面、配置、代码生成器)读不到请求参数,并对拼入的内容做白名单校验。`;
        } else if (position === "clause" || position === "identifier") {
          zh = `${label(scope)} 的标识符位置(表名、列名或排序字段)用 \${${fragment}} 拼接,该位置只能是标识符,#{ } 会把对方当成字符串字面量。`;
          en = `${label(scope)} builds an identifier (table, column or sort expression) from \${${fragment}}, which cannot be a bound parameter.`;
          suggestion =
            '用服务端白名单映射标识符:Map<String,String> SORTABLE = Map.of("name","user_name"),取 SORTABLE.get(param) 拼 SQL,取不到就报错;条件值仍用 #{ }。';
        } else if (BINDABLE_PATH.test(fragment)) {
          zh = `${label(scope)} 用 \${${fragment}} 拼接 SQL,该值会原样出现在语句里,存在 SQL 注入风险。`;
          en = `${label(scope)} interpolates \${${fragment}} into SQL text instead of binding it.`;
          // The full path, not its first segment: `#{params.pageSize}` binds and
          // `#{params}` would hand the driver a Map.
          suggestion = `改为预编译参数 #{${fragment}}。`;
        } else {
          zh = `${label(scope)} 用 \${${fragment}} 拼接 SQL,该值会原样出现在语句里,存在 SQL 注入风险。`;
          en = `${label(scope)} interpolates \${${fragment}} into SQL text instead of binding it.`;
          suggestion = `${fragment} 不是能直接绑定的属性路径:先在 Java 侧算出值(或拆成一个入参),再用 #{ } 绑定那个入参。`;
        }

        out.push(draft(rule, unit, line, zh, en, { severity, suggestion }));
      }
    }
    return out;
  },
};

function label(scope: SqlScope): string {
  return scope.source === "xml" ? `${scope.kind}#${scope.id}` : `@${scope.kind[0]?.toUpperCase()}${scope.kind.slice(1)} 注解 SQL`;
}

export default rule;
