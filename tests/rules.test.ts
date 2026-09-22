import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reviewUnits } from "../src/rules/engine.js";
import { rules } from "../src/rules/index.js";
import type { Finding, ReviewOptions, ReviewUnit } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, "fixtures", ...parts), "utf8");

function unit(path: string, content: string, addedLines: Set<number> | null = null): ReviewUnit {
  return {
    path,
    content,
    addedLines,
    contentSource: "worktree",
    complete: true,
    lang: path.endsWith(".xml") ? "xml" : "java",
  };
}

const DEFAULTS: ReviewOptions = { minSeverity: "info", exclude: [], experimental: false };

function run(units: ReviewUnit[], overrides: Partial<ReviewOptions> = {}): Finding[] {
  return reviewUnits(units, rules, { ...DEFAULTS, ...overrides }).findings;
}

function lines(finding: Finding) {
  return finding.line;
}

function ruleLines(findings: Finding[], rule: string): number[] {
  return findings.filter((f) => f.rule === rule).map(lines).sort((a, b) => a - b);
}

/** Run the whole rule set over a throwaway mapper XML. */
function analyze(src: string): Finding[] {
  return run([unit("Scratch.xml", src)]);
}

function lineOf(source: string, needle: string): number {
  const at = source.split("\n").findIndex((l) => l.includes(needle));
  if (at < 0) throw new Error(`fixture line not found: ${needle}`);
  return at + 1;
}

/**
 * Rules report on the annotation line (the thing to change, and what a
 * reviewer's cursor lands on), so a member's line is the topmost annotation
 * directly above its signature.
 */
function annoOf(source: string, signatureNeedle: string): number {
  const lines = source.split("\n");
  const sig = lines.findIndex((l) => l.includes(signatureNeedle));
  if (sig < 0) throw new Error(`fixture line not found: ${signatureNeedle}`);
  let at = sig;
  while (at > 0 && (lines[at - 1] ?? "").trim().startsWith("@")) at--;
  return at + 1;
}

const badSrc = read("java", "BadUserService.java");
const bad = unit("com/example/demo/service/BadUserService.java", badSrc);
const cleanSrc = read("java", "CleanUserService.java");
const clean = unit("com/example/demo/service/CleanUserService.java", cleanSrc);

const badXmlSrc = read("xml", "BadUserMapper.xml");
const badXml = unit("com/example/demo/mapper/BadUserMapper.xml", badXmlSrc);
const cleanXmlSrc = read("xml", "CleanUserMapper.xml");
const mapperIface = read("java", "UserMapper.java");
const cleanXml = unit("com/example/demo/mapper/CleanUserMapper.xml", cleanXmlSrc);
cleanXml.companion = { path: "com/example/demo/mapper/UserMapper.java", content: mapperIface };

describe("SPR rules on the deliberately broken service", () => {
  const findings = run([bad]);

  it("SPR001 flags this.updateName() from a non-transactional caller", () => {
    expect(ruleLines(findings, "SPR001")).toEqual([lineOf(badSrc, "this.updateName(id, name);")]);
  });

  it("SPR001 resolves a self call by name and arity, not by scanning every method", () => {
    // The candidate lookup used to be a linear filter over every method in the
    // class, once per call site. Indexing by name must not lose the arity check —
    // these two classes differ only in how many arguments `run` takes.
    const arityMismatch = [
      "package demo;",
      "import org.springframework.transaction.annotation.Transactional;",
      "public class S {",
      "    public void caller() {",
      "        this.run(1);",
      "    }",
      "    @Transactional public void run(int a, int b) {}",
      "}",
    ].join("\n");
    expect(ruleLines(run([unit("S.java", arityMismatch)]), "SPR001")).toEqual([]);

    const arityMatch = arityMismatch.replace('run(int a, int b)', 'run(int a)');
    expect(ruleLines(run([unit("S.java", arityMatch)]), "SPR001")).toEqual([
      lineOf(arityMatch, "this.run(1);"),
    ]);
  });

  it("SPR002 names the checked exception as the author wrote it", () => {
    const src = [
      "package demo;",
      "import org.springframework.stereotype.Service;",
      "import org.springframework.transaction.annotation.Transactional;",
      "@Service",
      "public class ApiService {",
      "    @Transactional",
      "    public void commit() throws java.io.IOException, IllegalStateException {",
      '        throw new java.io.IOException("x");',
      "    }",
      "}",
    ].join("\n");
    const hit = run([unit("ApiService.java", src)]).find((f) => f.rule === "SPR002");
    // The qualified name used to be split on its dots, which read as a list of
    // three exceptions: `java, io, IOException`.
    expect(hit?.message).toContain("java.io.IOException");
    expect(hit?.message).not.toContain("java, io,");
    // A runtime exception in the same clause is not a rollback gap.
    expect(hit?.message).not.toContain("IllegalStateException");
  });

  it("SPR002 flags the checked-exception transactional method without rollbackFor", () => {
    expect(ruleLines(findings, "SPR002")).toEqual([annoOf(badSrc, "public void importUsers")]);
  });

  it("SPR003 covers non-public, self-invoked and argument-taking @Async/@Scheduled", () => {
    const at = ruleLines(findings, "SPR003");
    expect(at).toContain(annoOf(badSrc, "private void drainQueue()"));
    expect(at).toContain(lineOf(badSrc, "notifyLater(payload);"));
    expect(at).toContain(annoOf(badSrc, "public void nightly(String tenant)"));
  });

  it("SPR004 flags executors and threads created inside the bean", () => {
    const at = ruleLines(findings, "SPR004");
    expect(at).toContain(lineOf(badSrc, "Executors.newFixedThreadPool(8)"));
    expect(at).toContain(lineOf(badSrc, "new Thread("));
  });

  it("SPR006 flags both the missing key and the bypassed cache", () => {
    const at = ruleLines(findings, "SPR006");
    expect(at).toContain(annoOf(badSrc, "public User findUser(Long tenantId, Long userId)"));
    expect(at).toContain(lineOf(badSrc, "this.findUser(tenantId, userId)"));
  });

  it("MYB002 flags mapper calls inside for and forEach", () => {
    const at = ruleLines(findings, "MYB002");
    expect(at).toContain(lineOf(badSrc, "result.add(userMapper.selectById(id))"));
    expect(at).toContain(lineOf(badSrc, "deptMapper.selectUser(id)"));
    expect(at).toContain(lineOf(badSrc, "userMapper.insertOne(user)"));
  });

  it("MYB002 still flags a real stream over a collection", () => {
    const src = `package a;
import com.example.demo.mapper.OrderMapper;
class S { private OrderMapper orderMapper;
  java.util.List<String> load(java.util.List<Long> ids) {
    return ids.stream().map(id -> orderMapper.selectById(id).getName()).toList();
  } }
`;
    const hit = run([unit("a/S.java", src)]);
    expect(ruleLines(hit, "MYB002")).toContain(lineOf(src, "orderMapper.selectById(id)"));
  });

  it("MYB002 does not treat Optional.map as a loop", () => {
    // A single-row update inside Optional.map fired MYB002 on real gateway code.
    expect(run([clean]).filter((f) => f.rule === "MYB002")).toEqual([]);
  });

  it("keeps SPR005 out until --experimental is passed", () => {
    expect(findings.some((f) => f.rule === "SPR005")).toBe(false);
    const withExperimental = run([bad], { experimental: true });
    const at = ruleLines(withExperimental, "SPR005");
    expect(at).toEqual(
      expect.arrayContaining([
        lineOf(badSrc, "private final Map<String, Integer> counter"),
        lineOf(badSrc, "private final List<User> buffer"),
      ]),
    );
  });
});

describe("false positives: the clean service must produce nothing", () => {
  it("0 findings with default rules", () => {
    expect(run([clean])).toEqual([]);
  });

  it("0 findings even with --experimental", () => {
    expect(run([clean], { experimental: true })).toEqual([]);
  });
});

describe("MYB rules on the deliberately broken mapper", () => {
  const findings = run([badXml]);

  it("MYB001 errors on a value interpolated into WHERE", () => {
    const hits = findings.filter((f) => f.rule === "MYB001" && f.severity === "error");
    expect(hits.map((h) => h.line)).toContain(lineOf(badXmlSrc, "'${keyword}'"));
  });

  it("MYB001 downgrades dynamic ORDER BY names to warn with a whitelist suggestion", () => {
    const orderLine = lineOf(badXmlSrc, "ORDER BY ${sortField}");
    const hits = findings.filter((f) => f.rule === "MYB001" && f.line === orderLine);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.severity === "warn")).toBe(true);
    expect(hits.every((h) => h.suggestion?.includes("白名单"))).toBe(true);
  });

  it("MYB001 stays silent on framework placeholders, loudly on app code", () => {
    // Measured: one real MyBatis Generator project produced 84 warnings for
    // `order by ${orderByClause}` before this was silenced. A rule that noisy
    // gets the whole rule set ignored.
    const wrapperLine = lineOf(badXmlSrc, "${ew.customSqlSegment}");
    expect(findings.filter((f) => f.line === wrapperLine)).toEqual([]);
    // …while the statement is still checked for the things that are app code:
    expect(ruleLines(findings, "MYB005")).not.toContain(wrapperLine);

    const generated = analyze([
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="G">',
      '  <select id="list" resultType="map">select id from t',
      '    <where><foreach collection="oredCriteria" item="c">${criterion.condition}</foreach></where>',
      '    <if test="orderByClause != null">order by ${orderByClause}</if>',
      "    limit 20",
      "  </select>",
      "</mapper>",
    ].join("\n"));
    expect(generated.filter((f) => f.rule === "MYB001")).toEqual([]);

    const handWritten = analyze([
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="H">',
      '  <select id="sorted" resultType="map">select id from t where a = 1 order by ${sortField} limit 20</select>',
      "</mapper>",
    ].join("\n"));
    expect(handWritten.filter((f) => f.rule === "MYB001").map((f) => f.severity)).toEqual(["warn"]);
  });

  it("MYB001 reports an ${} that lives in a shared <sql> fragment", () => {
    // The realistic shape of an injected search: one `<if>` block written once
    // and `<include>`d by every statement in the file. Statements were the only
    // thing scanned, and the placeholder is not inside any of them, so this
    // reported nothing at all.
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="F">',
      '  <sql id="kwWhere"><if test="kw != null">and name = ${kw}</if></sql>',
      '  <select id="a" resultType="map">select id from t where 1=1 <include refid="kwWhere"/></select>',
      '  <select id="b" resultType="map">select id from t where 1=1 <include refid="F.kwWhere"/></select>',
      "</mapper>",
    ].join("\n");
    const hits = analyze(src).filter((f) => f.rule === "MYB001");
    // Once, on the fragment — not once per `<include>`, which would put the
    // finding on a line that says nothing about the injection.
    expect(hits.map((h) => h.line)).toEqual([lineOf(src, "and name = ${kw}")]);
    expect(hits[0]?.message).toContain("sql#kwWhere");
  });

  it("a mapper that is only <sql> fragments is reviewed, not called inconclusive", () => {
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="Only">',
      '  <sql id="w">and name like \'%${kw}\'</sql>',
      "</mapper>",
    ].join("\n");
    const result = reviewUnits([unit("OnlyFragments.xml", src)], rules, DEFAULTS);
    expect(result.findings.map((f) => f.rule)).toContain("MYB001");
    expect(result.skipped).toEqual([]);
  });

  it("inlines a namespace-qualified <include> into the statement that uses it", () => {
    // `<include refid="Ns.Cols"/>` is the same fragment as `Cols` in this file.
    // Unresolved, the statement reads as `select from t` and MYB004 misses the
    // `SELECT *` the author actually wrote.
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="N">',
      '  <sql id="Cols">*</sql>',
      '  <select id="s" resultType="map">select <include refid="N.Cols"/> from t where id = #{id}</select>',
      "</mapper>",
    ].join("\n");
    expect(ruleLines(analyze(src), "MYB004")).toEqual([lineOf(src, '<select id="s"')]);
  });

  it("does not claim a full-table read when the WHERE may live in another file", () => {
    // `<include refid="demo.A.commonWhere"/>` cannot be resolved from this file.
    // Inlining it as nothing used to produce an *error* telling the author their
    // unbounded SELECT has no WHERE — a false positive on the exact shape
    // MyBatis `<sql>` sharing exists for.
    const opaque = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="demo.B">',
      '  <select id="s" resultType="map">select id from t<include refid="demo.A.commonWhere"/></select>',
      "</mapper>",
    ].join("\n");
    expect(ruleLines(analyze(opaque), "MYB005")).toEqual([]);

    // A fragment this file *can* see is still judged on what it says: `and 1 = 1`
    // is not a WHERE, so the unbounded read is still reported.
    const visible = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="demo.B">',
      '  <sql id="noise">and 1 = 1</sql>',
      '  <select id="s" resultType="map">select id from t<include refid="noise"/></select>',
      "</mapper>",
    ].join("\n");
    expect(ruleLines(analyze(visible), "MYB005")).toEqual([lineOf(visible, '<select id="s"')]);
  });

  it("reads annotation SQL from code and ignores the example in its own Javadoc", () => {
    // mybatis-3 produced exactly this finding on `annotations/Select.java`: the
    // javadoc of the `@Select` annotation shows `select *`, and the scan of
    // annotation SQL was reading the raw file rather than the comment-masked one.
    const doc = [
      "package demo;",
      "import java.util.List;",
      "import java.util.Map;",
      "import org.apache.ibatis.annotations.Select;",
      "",
      '/** Example: <pre>@Select("select * from users where name = \'${kw}\'")</pre> */',
      "public interface DocMapper {",
      '    @Select("select id from users where name = #{n} limit 20")',
      "    List<Map<String, Object>> real(String n);",
      "}",
    ].join("\n");
    expect(run([unit("DocMapper.java", doc)]).map((f) => f.rule)).toEqual([]);

    // The same text written as a real annotation is still reported — and on the
    // annotation's own line, not on the javadoc line that quotes it.
    const real = doc.replace("select id from users", "select * from users");
    expect(ruleLines(run([unit("DocMapper.java", real)]), "MYB004")).toEqual([
      lineOf(real, '    @Select("select * from users'),
    ]);
  });

  it("leaves XML documentation that merely quotes a mapper alone", () => {
    // MyBatis' own site docs are `<document>` files whose `<source>` blocks hold
    // mapper examples. Those examples are the documentation of a feature, not
    // code anybody ships, and reporting them is how the rule set gets ignored.
    const src = [
      '<?xml version="1.0"?>',
      "<document>",
      '  <section name="sqlmap">',
      "    <source><![CDATA[",
      '    <select id="selectBlog" resultType="Blog">',
      "      select * from blog where title like '%${kw}'",
      "    </select>",
      "    ]]></source>",
      "  </section>",
      "</document>",
      "",
    ].join("\n");
    const result = reviewUnits([unit("sqlmap-xml.xml", src)], rules, DEFAULTS);
    expect(result.findings).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("root element is <document>, not <mapper>");
  });

  it("names a mapper with no SQL in it once, not once per rule", () => {
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="R">',
      '  <resultMap id="rm" type="map"><id column="id" property="id"/></resultMap>',
      "</mapper>",
    ].join("\n");
    const result = reviewUnits([unit("OnlyMap.xml", src)], rules, DEFAULTS);
    expect(result.findings).toEqual([]);
    expect(result.skipped.filter((s) => s.reason.includes("no MyBatis SQL"))).toHaveLength(1);
  });

  it("treats `<include refid=\"${prop}\"/>` as a property, not an injection", () => {
    // Documented MyBatis behaviour: the placeholder picks which fragment to
    // include and its value comes from a `<property>` or config file.
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="P">',
      '  <select id="s" resultType="map">select id from t <include refid="${which}"/></select>',
      "</mapper>",
    ].join("\n");
    const hits = analyze(src).filter((f) => f.rule === "MYB001");
    expect(hits.map((h) => h.severity)).toEqual(["warn"]);
    expect(hits[0]?.message).toContain("refid");
  });

  it("ignores XML that is not a mapper, once rather than per rule", () => {
    const result = reviewUnits(
      [unit("pom.xml", '<?xml version="1.0"?><project><name>x</name><a>${prop}</a></project>')],
      rules,
      { ...DEFAULTS, minSeverity: "info" },
    );
    expect(result.findings).toEqual([]);
    expect(result.skipped.filter((s) => s.reason === "not a MyBatis mapper XML")).toHaveLength(1);
  });

  it("MYB003 catches the literal, the CONCAT and the <bind> forms", () => {
    const at = ruleLines(findings, "MYB003");
    expect(at).toContain(lineOf(badXmlSrc, "LIKE '%${keyword}%'"));
    expect(at).toContain(lineOf(badXmlSrc, "LIKE concat('%', #{keyword}, '%')"));
    expect(at).toContain(lineOf(badXmlSrc, "<bind name=\"pattern\""));
  });

  it("MYB003 escalates a placeholder written inside quotes", () => {
    // Straight from a shipping business project (newbee-mall's goods search):
    // CONCAT('%','#{goodsName}','%') never binds, so the filter compares against
    // literal text. Reporting that as "your LIKE cannot use an index" describes
    // the wrong problem and suggests the wrong fix.
    const broken = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="Q">',
      `  <select id="s" resultType="map">select id from t where name like CONCAT('%','#{kw}','%') limit 20</select>`,
      "</mapper>",
    ].join("\n");
    const hits = analyze(broken).filter((f) => f.rule === "MYB003");
    expect(hits.map((h) => h.severity)).toEqual(["error"]);
    expect(hits[0]?.message).toContain("'#{kw}'");

    // The bindable spelling stays a warn about the index, with no claim of breakage.
    const bindable = broken.replace("'#{kw}'", "#{kw}");
    const kept = analyze(bindable).filter((f) => f.rule === "MYB003");
    expect(kept.map((f) => f.severity)).toEqual(["warn"]);
    expect(kept[0]?.message).not.toContain("引号");
  });

  it("MYB004 flags SELECT * but never count(1)", () => {
    expect(ruleLines(findings, "MYB004")).toEqual([lineOf(badXmlSrc, "SELECT * FROM user")]);
  });

  it("MYB005 flags the unbounded dump", () => {
    expect(ruleLines(findings, "MYB005")).toContain(lineOf(badXmlSrc, "<select id=\"dumpAll\""));
  });

  it("MYB002 flags the resultMap nested select", () => {
    expect(ruleLines(findings, "MYB002")).toContain(lineOf(badXmlSrc, 'select="deptById"'));
  });
});

describe("false positives: the clean mapper must produce nothing", () => {
  it("0 findings when the companion interface proves selectPage is paged", () => {
    expect(run([cleanXml])).toEqual([]);
  });

  it("selectPage is reported when the interface is not available (documented degradation)", () => {
    const blind = unit("com/example/demo/mapper/CleanUserMapper.xml", cleanXmlSrc);
    const hits = run([blind]).filter((f) => f.rule === "MYB005");
    expect(hits.map((h) => h.line)).toEqual([lineOf(cleanXmlSrc, '<select id="selectPage"')]);
  });
});

describe("engine behaviour", () => {
  it("reports only lines the change actually added", () => {
    const added = new Set([lineOf(badSrc, "this.updateName(id, name);")]);
    const findings = run([unit(bad.path, bad.content, added)]);
    expect(findings.map((f) => f.rule)).toEqual(["SPR001"]);
  });

  it("honours a trailing-comment suppression on its own line", () => {
    const src = [
      "class S {",
      "  void a() { this.b(); } // spring-review:disable SPR001",
      "  @Transactional void b() {}",
      "}",
    ].join("\n");
    expect(run([unit("S.java", src)]).filter((f) => f.rule === "SPR001")).toEqual([]);
  });

  it("honours a standalone-comment suppression on the next line", () => {
    const standalone = [
      "class S {",
      "  void a() {",
      "    // spring-review:disable SPR001 \"已确认在同一事务内\"",
      "    this.b();",
      "  }",
      "  @Transactional void b() {}",
      "}",
    ].join("\n");
    expect(run([unit("S.java", standalone)]).filter((f) => f.rule === "SPR001")).toEqual([]);
    const withoutComment = standalone.replace(/.*disable SPR001.*\n/, "");
    expect(run([unit("S.java", withoutComment)]).filter((f) => f.rule === "SPR001")).toHaveLength(1);
  });

  it("supports disable-file and rule-scoped suppression", () => {
    const src = [
      "// spring-review:disable-file SPR001",
      "class S {",
      "  void a() { this.b(); }",
      "  @Transactional void b() {}",
      "}",
    ].join("\n");
    const findings = run([unit("S.java", src)]);
    expect(findings.filter((f) => f.rule === "SPR001")).toEqual([]);
    expect(findings.length).toBeGreaterThanOrEqual(0);
  });

  it("respects --min-severity and --disable", () => {
    const errorsOnly = run([bad], { minSeverity: "error" });
    expect(errorsOnly.every((f) => f.severity === "error")).toBe(true);
    const disabled = run([bad], { disabledRules: ["SPR001", "MYB002"] });
    expect(disabled.some((f) => f.rule === "SPR001")).toBe(false);
    expect(disabled.some((f) => f.rule === "MYB002")).toBe(false);
  });

  it("fills snippets from the reviewed file", () => {
    const findings = run([bad]);
    const hit = findings.find((f) => f.rule === "SPR001")!;
    expect(hit.snippet).toContain("this.updateName");
  });

  it("does not crash on a unit that is only a patch fragment", () => {
    const fragment = unit("X.java", "\n\n    this.updateName(id, name);\n\n", new Set([3]));
    fragment.complete = false;
    const result = reviewUnits([fragment], rules, { ...DEFAULTS });
    expect(result.findings).toEqual([]);
    expect(result.skipped.some((s) => s.reason.includes("patch fragment"))).toBe(true);
  });
});

describe("MYB001 advice follows the position the placeholder occupies", () => {
  // Evidence: a widely deployed admin framework (RuoYi-Vue) has six `${}` in its
  // mappers, and every one of them is either a whole injected WHERE clause
  // (`${params.dataScope}`, written by a data-scope aspect) or the entire body of
  // a statement (`${sql}` in the generator's createTable). "改为预编译参数" is not
  // a fix in those positions — it turns the SQL into a string literal — so the
  // suggestion has to say what the position can actually be given.
  const mapper = (body: string) =>
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="Pos">',
      body,
      "</mapper>",
    ].join("\n");

  function only(body: string, needle: string): Finding {
    const src = mapper(body);
    const hits = analyze(src).filter(
      (f) => f.rule === "MYB001" && f.line === lineOf(src, needle),
    );
    expect(hits.length).toBe(1);
    return hits[0]!;
  }

  it("binds a dotted path whole, not its first segment", () => {
    const hit = only(
      '  <select id="a" resultType="map">select id from t where del_flag = 0 and page_size = ${params.pageSize} limit 20</select>',
      "${params.pageSize}",
    );
    expect(hit.severity).toBe("error");
    expect(hit.suggestion).toBe("改为预编译参数 #{params.pageSize}。");
  });

  it("never proposes a bound parameter for a placeholder that is the whole condition", () => {
    const hit = only(
      [
        '  <select id="b" resultType="map">',
        "    select id from t",
        "    where u.del_flag = '0'",
        "    ${params.dataScope}",
        "  </select>",
      ].join("\n"),
      "${params.dataScope}",
    );
    expect(hit.severity).toBe("error");
    expect(hit.message).toContain("一整段 SQL 片段");
    // It may mention `#{}` to explain why that is not an option; it must not
    // recommend it, which is the advice that produced broken SQL.
    expect(hit.suggestion).toContain("换不成");
    expect(hit.suggestion).not.toContain("改为预编译参数");
    expect(hit.suggestion).toContain("替代不了一段 SQL");
    // The only real control point is where the text comes from.
    expect(hit.suggestion).toContain("来源");
  });

  it("does not call a statement that is nothing but ${} a bindable value", () => {
    const hit = only('  <update id="createTable">\n        ${sql}\n    </update>', "${sql}");
    expect(hit.suggestion).toContain("白名单");
    expect(hit.suggestion).not.toContain("改为预编译参数");
  });

  it("gives the whitelist advice for ORDER BY even when the name is not orderish", () => {
    const hit = only(
      '  <select id="c" resultType="map">select id from t where a = 1 order by ${params.sort} limit 20</select>',
      "${params.sort}",
    );
    expect(hit.suggestion).toContain("白名单");
    expect(hit.suggestion).not.toContain("改为预编译参数");
  });

  it("treats a table name as an identifier position, not a value", () => {
    const hit = only(
      '  <select id="e" resultType="map">select id from ${tableName} limit 20</select>',
      "${tableName}",
    );
    expect(hit.suggestion).toContain("白名单");
    expect(hit.message).toContain("标识符");
  });

  it("reads a column name out of `<foreach>${key} = #{item}`", () => {
    // Taken from MyBatis' own test corpus. The tag before the placeholder ends in
    // `>`, which a comparison operator also ends in — and `#{key}` there does not
    // bind a column, it compares a string literal to it.
    const hit = only(
      '  <update id="m">update t <foreach collection="m" item="v" index="key" separator=",">${key} = #{v}</foreach> where id = #{id}</update>',
      "${key}",
    );
    expect(hit.suggestion).toContain("白名单");
    expect(hit.suggestion).not.toContain("改为预编译参数");
  });

  it("does not bind a placeholder glued into an identifier", () => {
    const hit = only(
      '  <select id="h" resultType="map">select id from t where col_${suffix} = #{v} limit 20</select>',
      "${suffix}",
    );
    expect(hit.suggestion).toContain("白名单");
  });

  it("says OGNL, not prepared statement, for a placeholder in a tag attribute", () => {
    const hit = only(
      '  <select id="i" resultType="map">select id from t where a = 1<if test="\'${value}\' == \'x\'">and b = 2</if></select>',
      "${value}",
    );
    expect(hit.message).toContain("OGNL");
    expect(hit.suggestion).not.toContain("改为预编译参数");
  });

  it("says to compute an expression in Java instead of binding it", () => {
    const hit = only(
      '  <select id="f" resultType="map">select id from t where a = ${list.size()} limit 20</select>',
      "${list.size()}",
    );
    expect(hit.severity).toBe("error");
    expect(hit.suggestion).toContain("先在 Java 侧算出值");
  });

  it("keeps a quoted comparison value on the bound-parameter advice", () => {
    const hit = only(
      '  <select id="g" resultType="map">select id from t where name like \'%${keyword}%\'</select>',
      "${keyword}",
    );
    expect(hit.suggestion).toBe("改为预编译参数 #{keyword}。");
  });
});

describe("units reports what was actually looked at", () => {
  it("excludes files skipped before any rule ran", () => {
    // The same run prints `skipped: pom.xml — not a MyBatis mapper XML`, so a
    // count that also includes those files contradicts its own output: "267
    // file(s) reviewed" on a repository where five were never parsed as SQL.
    const mapper =
      '<?xml version="1.0"?><mapper namespace="U"><select id="s" resultType="map">select id from t where a = ${a}</select></mapper>';
    const result = reviewUnits(
      [
        unit("User.xml", mapper),
        unit("pom.xml", '<?xml version="1.0"?><project><name>x</name></project>'),
        unit("logback.xml", '<?xml version="1.0"?><configuration><appender name="a"/></configuration>'),
      ],
      rules,
      { ...DEFAULTS },
    );
    expect(result.units).toBe(1);
    expect(result.skipped.filter((s) => s.reason.includes("not a MyBatis mapper XML"))).toHaveLength(2);
  });
});


describe("MYB001 reads the context a placeholder shares with its neighbours", () => {
  const onlyHere = (body: string, needle: string): Finding => {
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="Ctx">',
      body,
      "</mapper>",
    ].join("\n");
    const hits = analyze(src).filter(
      (f) => f.rule === "MYB001" && f.line === lineOf(src, needle),
    );
    expect(hits.length).toBe(1);
    return hits[0]!;
  };

  it("reads a values-list placeholder that starts its own line as a value", () => {
    // Straight out of MyBatis' own corpus: `values(` then a newline, then the
    // placeholder. Line-local context alone sees nothing before it and used to
    // call the first item of a VALUES list "an entire SQL fragment".
    const hit = onlyHere(
      [
        '  <insert id="j" parameterType="map">',
        "    insert into t (id, name)",
        "    values(",
        "    ${id}, #{name}",
        "    )",
        "  </insert>",
      ].join("\n"),
      "${id},",
    );
    expect(hit.suggestion).toBe("改为预编译参数 #{id}。");
  });

  it("stays silent on an index inside a bound parameter", () => {
    // `#{ids[${index}]}` chooses which element to bind; the substituted text never
    // reaches the SQL string, so calling it injection would be calling a prepared
    // statement a vulnerability.
    const src = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
      '<mapper namespace="Ix">',
      '  <select id="s" resultType="map">select id from t where id in <foreach item="item_id" index="index" open="(" close=")" separator="," collection="ids">#{ids[${index}]}</foreach></select>',
      "</mapper>",
    ].join("\n");
    expect(analyze(src).filter((f) => f.rule === "MYB001")).toEqual([]);
  });
});

describe("MYB005 reads a WHERE that arrives through <include>", () => {
  // RuoYi's SysConfigMapper.selectConfig is `<include refid="selectConfigVo"/>`
  // plus `<include refid="sqlwhereSearch"/>`, where the second fragment holds the
  // `<where>` block. Stripping `<where>` to a space deleted the only evidence that
  // the statement is bounded, and the tool called a filtered query a full-table
  // read. The tag now becomes the keyword MyBatis actually emits.
  const src = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "x">',
    '<mapper namespace="W">',
    '  <sql id="cols">select id, name from t</sql>',
    '  <sql id="whereId"><where><if test="id != null">and id = #{id}</if></where></sql>',
    '  <select id="find" resultType="map"><include refid="cols"/><include refid="W.whereId"/></select>',
    '  <select id="all" resultType="map"><include refid="cols"/></select>',
    '  <select id="trimmed" resultType="map">select id from t <trim prefix="WHERE" prefixOverrides="AND">and a = #{a}</trim></select>',
    '  <select id="noPrefix" resultType="map">select id from t <trim prefixOverrides="AND">and a = #{a}</trim></select>',
    "</mapper>",
  ].join("\n");
  const hits = analyze(src).filter((f) => f.rule === "MYB005").map((f) => f.line);

  it("stays silent when the condition comes from an included fragment", () => {
    expect(hits).not.toContain(lineOf(src, '<select id="find"'));
  });

  it("still fires when nothing bounds the read", () => {
    expect(hits).toContain(lineOf(src, '<select id="all"'));
  });

  it("keeps a tag it cannot read as 'unknown', not as 'absent'", () => {
    // `<trim prefixOverrides="AND">` without a prefix might still be a WHERE
    // clause: the prefix can come from a nested `<where>`, which this file may
    // not contain at all. Concluding "no WHERE" from that is how the rule gets
    // switched off, so an unreadable `<trim>` bounds the statement.
    expect(hits).not.toContain(lineOf(src, '<select id="noPrefix"'));
  });

  it("counts a `<trim prefix=\"WHERE\">` as the keyword it emits", () => {
    expect(hits).not.toContain(lineOf(src, '<select id="trimmed"'));
  });
});
