import { describe, expect, it } from "vitest";
import { parseDiff, reconstructFile } from "../src/diff/parse.js";

const PATCH = [
  "diff --git a/src/main/java/demo/UserService.java b/src/main/java/demo/UserService.java",
  "index 1111111..2222222 100644",
  "--- a/src/main/java/demo/UserService.java",
  "+++ b/src/main/java/demo/UserService.java",
  "@@ -1,4 +1,5 @@",
  " line1",
  " line2",
  "+added3",
  " line3",
  " line4",
  "@@ -20,3 +21,4 @@",
  " context21",
  "+new22",
  " context22",
  " context23",
  "",
].join("\n");

describe("parseDiff — line-number mapping", () => {
  it("maps added lines to their HEAD line numbers across hunks", () => {
    const files = parseDiff(PATCH);
    expect(files).toHaveLength(1);
    const f = files[0] as ReturnType<typeof parseDiff>[number];
    expect(f.path).toBe("src/main/java/demo/UserService.java");
    expect(f.hunks).toBe(2);
    expect([...f.addedLines.entries()]).toEqual([
      [3, "added3"],
      [22, "new22"],
    ]);
    expect([...f.contextLines.keys()].sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 21, 23, 24]);
  });

  it("keeps the old-side numbering out of the added map", () => {
    const f = parseDiff(PATCH)[0]!;
    expect(f.addedLines.has(21)).toBe(false);
    expect(f.addedLines.has(4)).toBe(false);
  });

  it("handles a brand new file", () => {
    const files = parseDiff(
      [
        "diff --git a/src/New.java b/src/New.java",
        "new file mode 100644",
        "index 0000000..abc1234",
        "--- /dev/null",
        "+++ b/src/New.java",
        "@@ -0,0 +1,3 @@",
        "+package demo;",
        "+",
        "+public class New {}",
      ].join("\n"),
    );
    expect(files[0]!.status).toBe("added");
    expect([...files[0]!.addedLines.keys()]).toEqual([1, 2, 3]);
    expect(files[0]!.addedLines.get(2)).toBe("");
  });

  it("drops deleted files (nothing is added)", () => {
    const files = parseDiff(
      [
        "diff --git a/Gone.java b/Gone.java",
        "deleted file mode 100644",
        "--- a/Gone.java",
        "+++ /dev/null",
        "@@ -1,2 +0,0 @@",
        "-package demo;",
        "-class Gone {}",
      ].join("\n"),
    );
    expect(files[0]!.status).toBe("deleted");
    expect(files[0]!.addedLines.size).toBe(0);
  });

  it("resolves renamed paths from the rename headers", () => {
    const files = parseDiff(
      [
        "diff --git a/src/Old.java b/src/NewName.java",
        "similarity index 92%",
        "rename from src/Old.java",
        "rename to src/NewName.java",
        "index 1234567..89abcde 100644",
        "--- a/src/Old.java",
        "+++ b/src/NewName.java",
        "@@ -5,2 +5,3 @@",
        " keep",
        "+inserted",
      ].join("\n"),
    );
    expect(files[0]!.status).toBe("renamed");
    expect(files[0]!.path).toBe("src/NewName.java");
    expect(files[0]!.oldPath).toBe("src/Old.java");
    expect([...files[0]!.addedLines.keys()]).toEqual([6]);
  });

  it("handles a rename with no content change (no hunks at all)", () => {
    const files = parseDiff(
      [
        "diff --git a/a/X.java b/b/Y.java",
        "similarity index 100%",
        "rename from a/X.java",
        "rename to b/Y.java",
      ].join("\n"),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("b/Y.java");
    expect(files[0]!.addedLines.size).toBe(0);
  });

  it("ignores the 'no newline at end of file' marker without shifting numbers", () => {
    const files = parseDiff(
      [
        "diff --git a/T.java b/T.java",
        "--- a/T.java",
        "+++ b/T.java",
        "@@ -1,2 +1,2 @@",
        " first",
        "-second",
        "+SECOND",
        "\\ No newline at end of file",
      ].join("\n"),
    );
    expect([...files[0]!.addedLines.entries()]).toEqual([[2, "SECOND"]]);
  });

  it("normalises CRLF patches", () => {
    const crlf = PATCH.replace(/\n/g, "\r\n");
    const files = parseDiff(crlf);
    expect([...files[0]!.addedLines.keys()]).toEqual([3, 22]);
    expect(files[0]!.addedLines.get(3)).toBe("added3");
  });

  it("accepts a blank context line whose leading space was stripped", () => {
    const files = parseDiff(
      [
        "diff --git a/B.java b/B.java",
        "--- a/B.java",
        "+++ b/B.java",
        "@@ -1,3 +1,4 @@",
        " a",
        "",
        " c",
        "+d",
      ].join("\n"),
    );
    expect([...files[0]!.addedLines.keys()]).toEqual([4]);
    expect(files[0]!.contextLines.get(2)).toBe("");
  });

  it("works without a `diff --git` header (patch(1) output)", () => {
    const files = parseDiff(
      ["--- a/src/P.java", "+++ b/src/P.java", "@@ -1 +1,2 @@", " one", "+two"].join("\n"),
    );
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/P.java");
    expect([...files[0]!.addedLines.keys()]).toEqual([2]);
  });

  it("handles a single-line hunk header with no counts", () => {
    const files = parseDiff(
      ["--- a/S.java", "+++ b/S.java", "@@ -7 +7,2 @@", "-old", "+new1", "+new2"].join("\n"),
    );
    expect([...files[0]!.addedLines.keys()]).toEqual([7, 8]);
  });

  it("paths containing spaces survive the header split", () => {
    const files = parseDiff(
      [
        "diff --git a/src dir/My Class.java b/src dir/My Class.java",
        "--- a/src dir/My Class.java",
        "+++ b/src dir/My Class.java",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
      ].join("\n"),
    );
    expect(files[0]!.path).toBe("src dir/My Class.java");
  });

  it("marks combined merge diffs as unsupported instead of mis-numbering", () => {
    const files = parseDiff(
      ["diff --cc src/M.java", "index 1111111,2222222..3333333", "--- a/src/M.java", "+++ b/src/M.java", "@@@ -1,2 -1,2 +1,3 @@@"].join("\n"),
    );
    expect(files[0]!.unsupported).toMatch(/combined/);
  });

  it("separates multiple files in one patch", () => {
    const files = parseDiff(
      [
        "diff --git a/One.java b/One.java",
        "--- a/One.java",
        "+++ b/One.java",
        "@@ -1 +1,2 @@",
        " a",
        "+b",
        "diff --git a/Two.java b/Two.java",
        "--- a/Two.java",
        "+++ b/Two.java",
        "@@ -1 +1,2 @@",
        " c",
        "+d",
      ].join("\n"),
    );
    expect(files.map((f) => f.path)).toEqual(["One.java", "Two.java"]);
    expect(files[1]!.addedLines.get(2)).toBe("d");
  });

  it("treats a removed line starting with '--' as a deletion, not a header", () => {
    const files = parseDiff(
      [
        "diff --git a/D.java b/D.java",
        "--- a/D.java",
        "+++ b/D.java",
        "@@ -1,2 +1,2 @@",
        " keep",
        "--- was a markdown rule",
        "+now text",
      ].join("\n"),
    );
    expect([...files[0]!.addedLines.entries()]).toEqual([[2, "now text"]]);
  });
});

describe("reconstructFile", () => {
  it("fills unknown lines with empty strings so numbering still matches HEAD", () => {
    const f = parseDiff(PATCH)[0]!;
    const { content, complete } = reconstructFile(f);
    const out = content.split("\n");
    expect(out[2]).toBe("added3");
    expect(out[21]).toBe("new22");
    expect(out[10]).toBe("");
    expect(complete).toBe(false); // hunks start at 1 and 21 ⇒ lines 6..20 unknown
  });

  it("reports complete content for a whole-file patch", () => {
    const f = parseDiff(
      [
        "diff --git a/Whole.java b/Whole.java",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/Whole.java",
        "@@ -0,0 +1,2 @@",
        "+package a;",
        "+class Whole {}",
      ].join("\n"),
    )[0]!;
    const { content, complete } = reconstructFile(f);
    expect(complete).toBe(true);
    expect(content.trim().split("\n")).toEqual(["package a;", "class Whole {}"]);
  });
});
