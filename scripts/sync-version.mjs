/**
 * Rewrites the version literal in src/version.ts from package.json.
 *
 * `npm version <x>` runs this through the `version` lifecycle, so a release
 * cannot ship a CLI whose `--version` disagrees with its tag. tests/cli.test.ts
 * asserts the same equality, which is the backstop if someone edits
 * package.json by hand instead.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const target = join(root, "src", "version.ts");
const source = readFileSync(target, "utf8");

const pattern = /(export const PACKAGE_VERSION = ")[^"]*(")/;
if (!pattern.test(source)) {
  console.error("src/version.ts no longer has the literal this script rewrites");
  process.exit(1);
}

const next = source.replace(pattern, `$1${version}$2`);
if (next !== source) {
  writeFileSync(target, next);
  console.log(`src/version.ts -> ${version}`);
}
