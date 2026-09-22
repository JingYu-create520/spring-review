# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version follows
semantic versioning, and `0.x` means "the rule set may still move".

## 0.1.9 — 2026-09-22

### Fixed

- **0.1.8's own rule-id check over-corrected.** `"disable": [" SPR002 "]` — a
  hand-edited JSON with a stray space — became a rejected run instead of a
  disabled rule, which is the same kind of pedantry the release was about. Ids are
  now split on whitespace and commas before matching, so `["spr002"]`,
  `[" SPR002 "]` and `["SPR001, SPR002"]` all do what their author meant. An id
  that names no rule is still refused.
- **MYB003 now separates a slow search from a broken one.** A `#{}` inside quotes
  is not a parameter: `CONCAT('%','#{goodsName}','%')` never binds the value. That
  was reported as a leading-wildcard warning with advice about indexes, next to
  statements where the placeholder is correctly unquoted and the only complaint is
  performance. Now the quoted form is an `error` saying to drop the quotes, and the
  bindable form stays a `warn` about the index.
- Both READMEs claimed a `#{}` cannot be written inside quotes. It can, and
  [newbee-mall](https://github.com/newbee-ltd/newbee-mall) — 98 files, a real
  business project with MyBatis XML — has it in two statements of its goods search
  (`NewBeeMallGoodsMapper.xml:84` and `:171`). That corpus is now in the table, and
  its two errors are the same kind of thing mall's private `@Scheduled` was: a
  feature that does not work, found in somebody else's shipped code.

## 0.1.8 — 2026-09-22

### Fixed

- **Three ways to turn the gate off by accident, now exit 2 instead.** Found by
  feeding the CLI input it should not have accepted:
  - `--min-severity high` (also `WARN`) matched no level, filtered out every
    finding, and reported `no findings` with exit 0. Unknown levels are a usage
    error now; case is not — `WARN` means `warn`.
  - A `.spring-review.json` that failed validation was *printed to stderr and
    ignored*, so `disable` and `exclude` silently stopped applying. The run stops.
  - `--disable SPR5` disabled nothing at all, while reading as "this repo turned
    that rule off". Rule ids are checked against the catalogue, in the config as
    well as the flags.
- **SPR002 named the exception wrong.** `throws java.io.IOException` was reported
  as `java, io, IOException` — the clause was split on its dots. Qualified names
  are kept as written now; the check already matched the simple name at the end.

## 0.1.7 — 2026-09-22

The first corpus with real MyBatis XML: `mybatis/mybatis-3`, 1837 files. It also
produced four fixes.

### Fixed

- **XML documentation that quotes a mapper was reviewed as if it were one.**
  MyBatis' site docs are `<document>` files whose `<source>` blocks contain
  example statements: 64 findings, all of them on prose, one of them an injection
  `error` on `<include refid="${include_target}"/>` — the documented way to choose
  a fragment. A complete file whose root element is not `<mapper>` is now skipped
  once, by name; a header-less patch fragment is still read, because it has no
  root to judge by.
- **Annotation SQL was read from the raw file**, so the Javadoc example inside
  `annotations/Select.java` produced a `SELECT *` finding on the framework's own
  documentation of the annotation. `@Select("…")` is now scanned from a copy with
  comments blanked and string literals kept — the two masks are different on
  purpose, and `JavaFile` carries both.
- **A mapper with no SQL in it logged one skip per rule again.** One line per file
  now: `no MyBatis SQL in this file`.
- **`${}` that only picks an include target is a `warn`.** The value comes from a
  `<property>` or config, and what it selects is a fragment name. Reporting it as
  an injection error is how a rule gets disabled; the message asks the one useful
  question, whether that property can be reached from a request.

## 0.1.6 — 2026-09-22

### Fixed

- **MYB005 reported an unbounded `SELECT` whose WHERE lives in another file.**
  `<include refid="demo.A.commonWhere"/>` points at a fragment this file cannot
  see, the refid inlined to nothing, and the absence of `WHERE` became an
  `error`-severity claim — a false positive on exactly the sharing pattern MyBatis
  `<sql>` blocks exist for. An include that could not be resolved now means
  "cannot tell", not "absent", and the statement is left alone.

  ```xml
  <select id="s">select id from t<include refid="demo.A.commonWhere"/></select>
  ```

  Before: `error MYB005 既没有 WHERE 条件也没有 LIMIT`. After: no finding, and a
  fragment the file *can* resolve is still judged on what it actually says.

## 0.1.5 — 2026-09-22

### Fixed

- **A patch that does not describe the file on disk used to pass quietly.** Line
  numbers were trusted once the real file had been found, so `--patch` run in the
  wrong directory — or an agent retrying `review_diff` against a tree that had
  moved — scored the added lines against unrelated code and reported a clean
  review. Context lines are now checked against the file (whitespace-insensitive,
  majority vote); on disagreement the run falls back to the patch's own text,
  marks the unit incomplete, and says which happened:

  ```
  src/UserMapper.xml — patch context does not match the file on disk,
                       so the patch's own lines were reviewed
  ```

  This is the failure mode a reviewer can't see: a clean result over code that
  was never looked at.

## 0.1.4 — 2026-09-22

### Fixed

- **`${}` inside a `<sql>` fragment was never reported.** MYB001 scanned statement
  bodies, and an `<include refid="kwWhere"/>` leaves the fragment's text outside
  every statement that uses it, so the ordinary shape of an injected search —
  one `<if test="kw != null">and name = ${kw}</if>` shared by five statements —
  produced nothing. `<sql>` fragments are scopes of their own now: one finding,
  on the line that holds the placeholder, instead of one per `<include>`. A
  mapper that consists only of fragments is no longer called inconclusive
  either.
- `<include refid="demo.OrderMapper.Cols"/>` resolves to the local `Cols` when
  the namespace matches, which is how the qualified form is normally written. A
  refid pointing into *another* file is still out of reach; that file is reviewed
  on its own, and its `${}` is reported there.

## 0.1.3 — 2026-09-22

### Fixed

- **The Action's `install-from: github` path did not run.** It used
  `npx github:JingYu-create520/spring-review#v0`, which asks every consumer's
  runner to build `dist/` from the devDependency tree first. CI run #20 showed
  what happens when that build does not happen: npx installs the package, finds
  no file behind the `bin`, and answers `spring-review: not found` with exit
  127. github mode now downloads a prebuilt tarball from Releases and runs
  `dist/cli.js` with node — nothing is built on your runner.
- **`--version` could disagree with the release.** `src/version.ts` carried the
  version by hand, and the 0.1.3 bump left it at 0.1.2 — visible when a local
  end-to-end run of the Action printed `spring-review 0.1.2` out of a
  `spring-review-0.1.3.tgz`. The test comparing the two existed all along and
  simply had not been run since the bump. `npm version` now rewrites it through
  the `version` lifecycle (`scripts/sync-version.mjs`), so the string and the tag
  move together.

### Removed

- The Action's `token` input, dead since 0.1.0. Nothing in the step ever read it:
  the annotations arrive because the runner parses the `::error` lines the CLI
  prints, so there was no API call to authenticate.

### Added

- `install-from` (`github` | `npm` | `local`) and `ref` inputs, defaulting to
  `github` + `latest`, so the Action works with no npm package published. `ref`
  also takes a full tarball URL, which is what a fork needs.
- `.github/workflows/release.yml`: pushing a `v*.*` tag packs the CLI, verifies
  the tarball really contains an executable `dist/cli.js`, and attaches it as
  `spring-review.tgz`. A stable asset name is what makes `releases/latest`
  downloadable by one URL.

## 0.1.2 — 2026-09-21

Everything below was found by scanning three public repositories (195 + 24 + 638
files) rather than the bundled demo.

### Fixed

- **MYB001 produced 84 findings on a MyBatis Generator project**, every one of them
  generated `order by ${orderByClause}`. Framework placeholders (`${ew.*}`,
  `${criterion.*}`, `${orderByClause}`, `${distinct}`) are now silent instead of
  downgraded to `warn`: a rule that floods generated code gets the entire rule set
  ignored. A hand-written `${sortField}` still reports, at `warn`.
- **Non-mapper XML logged one skip per rule.** `pom.xml` and `logback-spring.xml`
  now produce a single `not a MyBatis mapper XML` entry instead of four.

### Notes

- The same pass turned up a live bug in macrozheng/mall: `@Scheduled` on a private
  method, which Spring does not invoke. Both READMEs now carry the real-code table.

## 0.1.1 — 2026-09-21

Both defects below were found by running the tool over a real Spring gateway project rather than
over the bundled demo.

### Fixed

- **Whole-file mode reported a clean run over zero files.** `spring-review src/main/java` and
  `spring-review "src/**/*.java"` passed every path straight to `unitFromFile`, which returns
  null for a directory, so the run reviewed nothing and said nothing was wrong. The only trace was
  a `skipped` entry inside JSON output nobody reads. Paths now expand: directories recurse
  (`target/`, `build/`, `node_modules/`, `generated/` pruned), globs match, overlapping inputs
  collapse to one unit per file, and `--exclude` applies to whatever the walk finds. An input that
  yields nothing reviewable is named in the output instead of passing quietly.
- **`repository.findByName(name).map(e -> repository.save(e))` was reported as an N+1.**
  `loopRanges` matched `.map(` without asking what the receiver was, so `Optional.map` counted as
  a stream loop -- and the message asserted a cost the code cannot incur, since the lambda runs at
  most once. A single-result receiver (`find*/get*/load*/select*/of…`) is no longer treated as a
  loop; a real collection pipeline still fires. An `Optional` held in a local variable is still
  read as a stream, which needs the symbol table, and the limit is named in the code.

### Added

- `tests/paths.test.ts` (8 cases) and two `MYB002` regression tests, including a fixture guard in
  `CleanUserService.java`.
- A "Run against code that was not written for this tool" section in both READMEs: 195 files across
  two real gateway modules, 0 findings on one and 3 polling-loop findings in integration tests on
  the other, plus the gap that remains (no real MyBatis XML mapper has met the `MYB*` rules yet).

## 0.1.0 — 2026-09-20

First public version: the rule engine plus four ways to consume it.

### Added

- **11 deterministic rules**, no LLM and no API key involved:
  - `SPR001` `@Transactional` self-invocation (proxy bypass)
  - `SPR002` `@Transactional` without `rollbackFor` when a checked exception is thrown
  - `SPR003` `@Async` / `@Scheduled` that can never apply (non-public, static,
    self-invoked, or `@Scheduled` with arguments)
  - `SPR004` `new Thread` / `Executors.newXxx` created inside a singleton bean
  - `SPR005` mutable state on a singleton bean (behind `--experimental`)
  - `SPR006` `@Cacheable` bypassed by a self-call, or keyed by every argument
  - `MYB001` `${}` SQL injection, with MyBatis-Plus/Generator placeholders and
    dynamic ORDER BY downgraded to `warn` instead of silenced
  - `MYB002` N+1 queries (mapper call inside a loop/stream, `resultMap` nested select)
  - `MYB003` leading-wildcard `LIKE`, including the `concat('%', …)` and `<bind>` forms
  - `MYB004` `SELECT *`
  - `MYB005` unbounded `SELECT`, with `IPage`/PageHelper pagination recognised
- Unified-diff parsing with HEAD-accurate line mapping (CRLF, new/deleted/renamed
  files, `\ No newline at end of file`, header-less patches).
- Lightweight Java structure extractor (bracket state machine over a comment/string
  masked copy) and a MyBatis mapper XML reader.
- CLI (`spring-review`), MCP server (`review_diff` / `review_file` / `list_rules`),
  Agent Skill, and a composite GitHub Action using check-run annotations.
- Reports: `table` (colour), `json`, `github` (workflow annotations), `sarif`
  (SARIF 2.1.0 for GitHub Code Scanning, with all rule descriptions embedded).
- Optional prose polish via `--llm` against any OpenAI-compatible endpoint
  (`SR_LLM_BASE_URL` / `SR_LLM_API_KEY` / `SR_LLM_MODEL`); findings are identical
  with it on or off, which is asserted by tests.
- Inline suppression: `spring-review:disable[,-file]`, honoured on the same line
  and the following line.
- Supported runtimes: Node 20 / 22 / 24 (CI matrix). Node 18 reached end of life in
  April 2025, so the package does not claim it.
- `.spring-review.json` for per-repo `exclude` / `disable` / `minSeverity`.
- `examples/demo-project` — an ordinary-looking Spring Boot + MyBatis app with the
  mistakes planted unlabeled, plus two files written correctly on purpose.
  `tests/demo-project.test.ts` pins that all 11 rules fire there and that the clean
  files stay silent, so the README's numbers cannot drift into marketing.
