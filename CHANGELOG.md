# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version follows
semantic versioning, and `0.x` means "the rule set may still move".

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
