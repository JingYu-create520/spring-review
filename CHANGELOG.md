# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version follows
semantic versioning, and `0.x` means "the rule set may still move".

## 0.1.0 — unreleased

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
- `.spring-review.json` for per-repo `exclude` / `disable` / `minSeverity`.
