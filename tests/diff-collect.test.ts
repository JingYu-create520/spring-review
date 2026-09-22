import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff/parse.js";
import { unitsFromDiff } from "../src/diff/collect.js";

/**
 * A skip reason is the only thing a reader sees about the file that was *not*
 * reviewed, so it has to name the real cause. "no added lines" is technically
 * true of a combined merge diff and of a binary file, and tells the reader the
 * commit changed nothing, which is the opposite of what happened.
 */
describe("unitsFromDiff — why a file was not reviewed", () => {
  it("says so when the input cannot be mapped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sr-collect-"));
    try {
      const combined = parseDiff(
        [
          "diff --cc src/M.java",
          "index aaa1111,bbb2222..ccc3333",
          "--- a/src/M.java",
          "+++ b/src/M.java",
          "@@@ -1,2 -1,2 +1,3 @@@",
          "  package demo;",
          "+    public void a() {}",
        ].join("\n"),
      );
      const mergeRun = await unitsFromDiff(combined, { cwd: dir });
      expect(mergeRun.units).toHaveLength(0);
      expect(mergeRun.skipped[0]?.path).toBe("src/M.java");
      expect(mergeRun.skipped[0]?.reason).toBe("combined merge diff is not supported");

      const binary = parseDiff(
        [
          "diff --git a/src/B.java b/src/B.java",
          "index 1111111..2222222 100644",
          "Binary files a/src/B.java and b/src/B.java differ",
        ].join("\n"),
      );
      const binaryRun = await unitsFromDiff(binary, { cwd: dir });
      expect(binaryRun.skipped[0]?.reason).toBe("binary file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
