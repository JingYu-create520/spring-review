import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyzeJava,
  callSites,
  hasAnnotation,
  loopRanges,
  maskJavaLiterals,
  methodsOf,
  nestedBodiesWithin,
  writtenIdentifiers,
} from "../src/analyze/java.js";

const here = dirname(fileURLToPath(import.meta.url));
const edge = readFileSync(join(here, "fixtures/java/StructuralEdgeCases.java"), "utf8");

function findMember(java: ReturnType<typeof analyzeJava>, name: string) {
  const m = java.members.filter((x) => x.name === name).pop();
  if (!m) throw new Error(`member ${name} not found`);
  return m;
}

describe("maskJavaLiterals", () => {
  it("preserves length and newlines while blanking literals", () => {
    const src = 'a "{" b; // }\nString s = "x\\"y"; /* \n */ c;\n';
    const masked = maskJavaLiterals(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split("\n").length).toBe(src.split("\n").length);
    expect(masked).not.toContain('"x');
    expect(masked.split("\n")[1]).toContain("String s =");
  });

  it("blanks text blocks", () => {
    const src = 'String t = """\n  { bracket } \n  """;\n';
    expect(maskJavaLiterals(src)).not.toContain("bracket");
  });
});

describe("analyzeJava — structure", () => {
  const java = analyzeJava("StructuralEdgeCases.java", edge);

  it("finds top level and nested types, and treats anonymous classes separately", () => {
    expect(java.diagnostics).toEqual([]);
    const names = java.types.map((t) => t.name);
    expect(names).toContain("StructuralEdgeCases");
    expect(names).toContain("Inner");
    expect(names).toContain("Runnable<anonymous>");
    const outer = java.types.find((t) => t.name === "StructuralEdgeCases")!;
    expect(outer.annotations).toEqual([]);
    expect(outer.modifiers).toContain("public");
    expect(java.types.find((t) => t.name === "Inner")?.enclosing).toBeDefined();
  });

  it("extracts methods with modifiers, params and annotations", () => {
    const runIt = findMember(java, "runIt");
    expect(runIt.modifiers).toContain("public");
    expect(runIt.params).toEqual([]);
    expect(runIt.kind).toBe("method");
    expect(runIt.returnType).toBe("void");
    expect(runIt.endLine).toBeGreaterThan(runIt.line);

    const doInner = findMember(java, "doInner");
    expect(java.types[doInner.owner]?.name).toBe("Inner");
  });

  it("detects constructors and fields with generics", () => {
    const ctor = java.members.find((m) => m.kind === "constructor");
    expect(ctor?.name).toBe("StructuralEdgeCases");
    const field = java.fields.find((f) => f.names.includes("counts"));
    expect(field?.type).toBe("int[]");
  });

  it("does not mistake braces inside strings or comments for structure", () => {
    const helper = findMember(java, "helper");
    // helper() is the last one declared in the outer class
    expect(helper.bodyEnd).toBeGreaterThan(helper.bodyStart);
    const names = java.members.map((m) => m.name);
    expect(names).not.toContain("nope");
    expect(names).not.toContain("NotReal");
  });
});

describe("analyzeJava — call sites", () => {
  const java = analyzeJava("StructuralEdgeCases.java", edge);

  it("sees bare and receiver-qualified calls in a method body", () => {
    const runIt = findMember(java, "runIt");
    const calls = callSites(java, runIt).map((c) => `${c.receiver.join(".")}|${c.callee}`);
    expect(calls).toContain("|helper");
    expect(calls).toContain("r|run");
  });

  it("excludes calls that live inside an anonymous class body", () => {
    const runIt = findMember(java, "runIt");
    const ranges = nestedBodiesWithin(java, runIt);
    expect(ranges.length).toBeGreaterThan(0);
    const calls = callSites(java, runIt);
    // `helper();` appears twice in the raw text; only the outer one is reported.
    expect(calls.filter((c) => c.callee === "helper")).toHaveLength(1);
  });

  it("ignores control keywords, constructors and annotation usages", () => {
    const src = [
      "class K {",
      "  @Override",
      "  void m() {",
      "    if (x) { for (int i = 0; i < 3; i++) { while (y) { t(); } } }",
      "    Foo f = new Foo();",
      "    int[] a = new int[] {1, 2};",
      "  }",
      "}",
    ].join("\n");
    const j = analyzeJava("K.java", src);
    const calls = callSites(j, findMember(j, "m"));
    expect(calls.map((c) => c.callee).sort()).toEqual(["t"]);
  });
});

describe("analyzeJava — loop bodies", () => {
  const src = [
    "class L {",
    "  void each(List<Long> ids) {",
    "    for (Long id : ids) {",
    "      mapper.touch(id);",
    "    }",
    "    ids.forEach(id -> mapper.ping(id));",
    "    int n = 0;",
    "    while (n < 5) { mapper.pull(n); n++; }",
    "    ids.stream().map(id -> mapper.fetch(id)).toList();",
    "  }",
    "}",
  ].join("\n");
  const java = analyzeJava("L.java", src);
  const each = findMember(java, "each");
  const ranges = loopRanges(java, each);
  const calls = callSites(java, each).filter((c) => c.receiver.join(".") === "mapper");

  it("finds for / forEach / while / stream bodies", () => {
    expect(new Set(ranges.map((r) => r.kind))).toEqual(
      new Set(["for", "forEach", "while", "stream"]),
    );
  });

  it("locates mapper calls textually inside those bodies", () => {
    const inside = calls.filter((c) => ranges.some((r) => c.offset > r.start && c.offset < r.end));
    expect(inside.map((c) => c.callee).sort()).toEqual(["fetch", "ping", "pull", "touch"]);
  });
});

describe("analyzeJava — writes and annotations", () => {
  const src = [
    "class W {",
    "  private Map<String, Integer> counter = new HashMap<>();",
    "  private int total;",
    "  @Transactional(rollbackFor = Exception.class)",
    "  public void bump(String k) {",
    "    counter.put(k, 1);",
    "    total++;",
    "    int total2 = 3;",
    "    if (total == 5) { return; }",
    "  }",
    "}",
  ].join("\n");
  const java = analyzeJava("W.java", src);
  const bump = findMember(java, "bump");

  it("records mutating writes to fields", () => {
    const written = writtenIdentifiers(java, bump);
    expect(written.has("counter")).toBe(true);
    expect(written.has("total")).toBe(true);
  });

  it("does not treat a comparison as a write", () => {
    const written = writtenIdentifiers(java, bump);
    expect(written.has("total2")).toBe(false); // local declaration, not a field write
  });

  it("reads annotation arguments with balanced parens", () => {
    const tx = java.members.find((m) => hasAnnotation(m.annotations, "Transactional"))!;
    const anno = tx.annotations.find((a) => a.name === "Transactional")!;
    expect(anno.args).toContain("rollbackFor = Exception.class");
  });

  it("exposes methods per declaring type", () => {
    const j = analyzeJava("StructuralEdgeCases.java", edge);
    const outerIndex = j.types.findIndex((t) => t.name === "StructuralEdgeCases");
    expect(methodsOf(j, outerIndex).map((m) => m.name)).toContain("runIt");
    expect(methodsOf(j, outerIndex).map((m) => m.name)).not.toContain("run");
  });
});
