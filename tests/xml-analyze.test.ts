import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzeMapperXml, resolveIncludes, stripTags } from "../src/analyze/xml.js";

const here = dirname(fileURLToPath(import.meta.url));
const edgeSrc = readFileSync(join(here, "fixtures/xml/EdgeMapper.xml"), "utf8");
const edge = analyzeMapperXml("EdgeMapper.xml", edgeSrc);

const stmt = (id: string) => {
  const s = edge.statements.find((x) => x.id === id);
  if (!s) throw new Error(`statement ${id} missing — got ${edge.statements.map((x) => x.id)}`);
  return s;
};

describe("analyzeMapperXml", () => {
  it("reads the namespace and every statement id", () => {
    expect(edge.diagnostics).toEqual([]);
    expect(edge.namespace).toBe("com.example.demo.edge.EdgeMapper");
    expect(edge.statements.map((s) => s.id).sort()).toEqual([
      "byIds",
      "cdata",
      "deptById",
      "paged",
    ]);
  });

  it("keeps statement line ranges aligned with the file", () => {
    const s = stmt("byIds");
    expect(edge.lines[s.line - 1]).toContain('<select id="byIds"');
    expect(edge.lines[s.endLine - 1]).toContain("</select>");
  });

  it("strips dynamic tags from the SQL text but keeps their conditions", () => {
    const s = stmt("byIds");
    expect(s.sql).toContain("id IN");
    expect(s.sql).not.toContain("<where>");
    expect(s.sql).toContain("LIMIT 100");
  });

  it("unwraps CDATA so its operators stay visible", () => {
    const s = stmt("cdata");
    expect(s.sql).toContain("level <> 'ERROR'");
    expect(s.sql).toContain("LIKE 'a%'");
  });

  it("never sees SQL inside XML comments", () => {
    expect(edge.statements.some((s) => s.sql.includes("${id}"))).toBe(false);
    expect(edge.statements.some((s) => s.sql.includes("not_real"))).toBe(false);
  });

  it("collects <sql> fragments and inlines them via <include>", () => {
    expect(Object.keys(edge.fragments)).toContain("Base_Column_List");
    const inlined = resolveIncludes(edge, stmt("byIds"));
    expect(inlined).toContain("user_name");
    expect(inlined).toContain("dept_id");
  });

  it("records resultMap nested selects (the N+1 signal)", () => {
    expect(edge.resultMaps).toHaveLength(1);
    const map = edge.resultMaps[0]!;
    expect(map.id).toBe("UserWithDept");
    expect(map.nestedSelectLines).toHaveLength(1);
    expect(edge.lines[map.nestedSelectLines[0]! - 1]).toContain('select="deptById"');
  });

  it("captures statement attributes for later rules", () => {
    expect(stmt("byIds").attributes["resultType"]).toBe("com.example.demo.edge.User");
  });

  it("skips XML that is not a mapper", () => {
    const other = analyzeMapperXml("pom.xml", '<project><name>x</name></project>');
    expect(other.statements).toEqual([]);
    expect(other.diagnostics.join(" ")).toMatch(/not <mapper>/);
  });

  it("handles self-closing and single-line statements", () => {
    const one = analyzeMapperXml(
      "One.xml",
      [
        '<?xml version="1.0"?>',
        "<!DOCTYPE mapper PUBLIC \"-//mybatis.org//DTD Mapper 3.0//EN\" \"x\">",
        '<mapper namespace="N">',
        '  <select id="x" resultType="int">SELECT count(1) FROM t WHERE a = 1</select>',
        "</mapper>",
      ].join("\n"),
    );
    expect(one.statements).toHaveLength(1);
    expect(one.statements[0]!.line).toBe(one.statements[0]!.endLine);
  });
});

describe("stripTags", () => {
  it("leaves parameter placeholders alone", () => {
    expect(stripTags('a <if test="x">#{id}</if> b')).toBe("a  #{id}  b");
  });
});
