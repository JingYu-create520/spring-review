# spring-review

Line-level review of Spring and MyBatis changes. Give it a git diff; get back
findings with a file, a line number, and the rule that fired.

It exists for the mistakes you have to know Spring to see:

- `@Transactional` on a method called from inside the same class. The proxy never
  sees that call, so nothing is transactional. It compiles, it starts, it passes review.
- `@Transactional` on a method that `throws IOException`. Spring rolls back on
  RuntimeException only, so a checked exception commits the half-finished write.
- `orderLineMapper.selectPrice(id)` inside a `for` loop. One query per element.
- `where name = '${keyword}'` in a Mapper XML. `${}` is string concatenation.
- `like concat('%', #{kw}, '%')`. A leading `%` is where the index stops helping.
- `Executors.newFixedThreadPool(8)` called from a singleton bean's method.

Rules make these calls, offline and without an API key, so the same diff gives the
same output. `--llm` rewrites the summary paragraph and nothing else.

![spring-review reviewing two files of examples/demo-project: 6 errors and 2 warnings, each with a rule id, a line number, the offending code and a fix](./docs/assets/demo.png)

> [中文 README](./README.zh-CN.md) · [Rules](#rules) · [Why not just ask the model](#why-not-just-ask-the-model) · [What it does not do](#what-it-does-not-do)

Exit codes: `0` nothing blocking, `1` at least one error-severity finding, `2` the
tool could not run.

## Install

The npm package is not published yet. The CLI comes from this repository's
Releases instead, and Node 20 or newer is the only requirement:

```bash
npm i -g https://github.com/JingYu-create520/spring-review/releases/latest/download/spring-review.tgz
spring-review --diff origin/main..HEAD
```

`releases/latest` moves; `releases/download/v0.1.3/spring-review.tgz` does not.
To work on the tool rather than use it, clone it and run the build:

```bash
git clone https://github.com/JingYu-create520/spring-review.git
cd spring-review
npm ci && npm run build
node dist/cli.js --patch examples/sample.patch
```

Below, `spring-review` means either of those two CLIs.

## Usage

```bash
spring-review                              # uncommitted changes
spring-review --diff origin/main..HEAD     # a commit range
spring-review --staged
spring-review --file src/main/java/demo/UserService.java
spring-review src/main/java                # a directory, recursively
spring-review "src/**/*Service.java"       # or a glob
spring-review --patch pr.patch --format github
```

A path may be a file, a directory or a glob; `target/`, `build/`, `node_modules/`
and `generated/` are never walked. An input that yields nothing reviewable is
named in the output rather than passing quietly — a linter that reports "clean"
over zero files is worse than one that fails. A patch whose context lines do not
match the file it claims to change is named the same way: the review falls back to
the patch's own lines, because scoring added numbers against unrelated code
produces the one result nobody should trust.

Only added lines are reported, so existing code does not come back to haunt you.
Other flags: `--min-severity error|warn|info`, `--exclude '**/generated/**'`,
`--disable SPR005`, `--experimental`, `--list-rules`. A repo can keep its own
settings in `.spring-review.json` (`exclude`, `disable`, `minSeverity`).

To silence one finding, say why:

```java
// spring-review:disable MYB001 "sortField 来自服务端白名单映射"
```

That works on the offending line or the line above it; `disable-file` covers a whole
file.

### GitHub Action

```yaml
on: [pull_request]
permissions: { contents: read, checks: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: JingYu-create520/spring-review@v0
        with:
          exclude: "**/generated/**"
```

Findings arrive as check-run annotations, which is why there is no token to hand
over and no comment thread to de-duplicate. `fail-on-error: false` keeps the job
green and still marks the lines; it does that by re-emitting at `notice` level,
because a `::error` workflow command fails the run whatever the exit code says.

The Action downloads the prebuilt `spring-review.tgz` from this repository's
Releases and runs it with node in a temporary directory, so the runner builds
nothing and there is no npm package to wait for. `ref: v0.1.3` pins the CLI to a
version. `install-from: npm` switches over once the package exists;
`install-from: local` runs a build already present in the job. CI exercises the
github and local paths on every push.

`@v0` is a moving tag that CI keeps pointed at the `main` commit that passed
those jobs; `@v0.1.3` freezes the Action itself as well.

### Code scanning

`--format sarif` writes SARIF 2.1.0 with all rule descriptions embedded, so findings
sit on the Security tab instead of scrolling past:

```yaml
- run: spring-review --diff origin/main..HEAD --format sarif > spring-review.sarif
- uses: github/codeql-action/upload-sarif@v4
  with: { sarif_file: spring-review.sarif, category: spring-review }
```

This repo runs it against its own fixtures on every push to `main`. The Security
tab holds 21 open alerts; a 22nd closed itself when 0.1.2 stopped reporting the
framework `${ew.customSqlSegment}` placeholder, because an upload that no longer
lists a finding marks it fixed.

### MCP server

```json
{
  "mcpServers": {
    "spring-review": {
      "command": "node",
      "args": ["/path/to/spring-review/dist/cli.js", "mcp"]
    }
  }
}
```

Three tools: `review_diff` (patch text, or a range plus a `cwd`), `review_file`,
`list_rules`. `skills/spring-review/SKILL.md` is the same knowledge aimed at agents
that read skills instead of speaking MCP.

## Rules

`spring-review --list-rules` prints these with rationale, machine-readable.

| ID | Catches | Sev |
| --- | --- | --- |
| SPR001 | `@Transactional` self-invocation, by `this.m()` or a bare `m()` | error |
| SPR002 | `@Transactional` with a checked exception and no `rollbackFor` | error |
| SPR003 | `@Async`/`@Scheduled` that cannot apply: non-public, static, self-invoked, or `@Scheduled` with arguments | error |
| SPR004 | `new Thread` / `Executors.newXxx` inside a singleton bean | error |
| SPR005 | mutable instance state written from unguarded methods (`--experimental`) | warn |
| SPR006 | `@Cacheable` bypassed by a self-call, or keyed by every argument | warn |
| MYB001 | `${}` interpolation: statements, `<sql>` fragments, `@Select` SQL | error |
| MYB002 | N+1: mapper call in a loop or stream, or a `resultMap` nested select | error |
| MYB003 | leading-wildcard `LIKE`, as a literal, via `concat`, or via `<bind>` | warn |
| MYB004 | `SELECT *` | warn |
| MYB005 | `SELECT` with no `WHERE` and no `LIMIT` | error |

Three of those are less obvious than they look, and they are the reason the rule set
is small.

`${}` cannot simply be reported everywhere. MyBatis-Plus and MyBatis Generator put
their own text through `${ew.customSqlSegment}`, `${criterion.condition}` and
`order by ${orderByClause}`; those are framework contract and are silent, because
warning on generated code is how a rule set earns to be ignored wholesale. What
does get reported is `${}` in code someone wrote: a dynamic `ORDER BY ${sortField}`
drops to `warn` rather than `error`, because it cannot be turned into `#{}` —
column names are not bindable — and the useful answer is a server-side whitelist
that rejects anything unmapped. A placeholder written once in a shared
`<sql id="kwWhere">` block and `<include>`d by five statements is reported on the
block, once. That is the line to change, and it is where the injection is; the
statement bodies never contained it.

`SELECT` with no `LIMIT` is not always a full-table read. Under MyBatis-Plus the
interceptor adds pagination and the SQL stays bare, so the rule follows the mapper
XML's `namespace` to its interface and exempts statements whose parameters take an
`IPage`/`Page`. Without that step it would flag every paged query in a MyBatis-Plus
codebase, which is most of them. Text this file cannot see counts as unknown rather
than absent: an `<include refid="other.Mapper.commonWhere">` that resolves to nothing
is where the condition may be hiding.

A leading-wildcard `LIKE` almost never appears as `'%foo%'` in a mapper, because
`#{}` cannot sit inside quotes. The real forms are `concat('%', #{kw}, '%')` and
`<bind value="'%' + kw + '%'/>`. Matching only the literal would make the rule
quietly useless.

## Why not just ask the model

Three things a model does not do with a diff. It cannot give you a line number you
can click. It cannot promise the same answer twice, so it cannot gate a merge. And it
does not know that `ORDER BY ${sortField}` is a whitelist problem rather than a "use
`#{}`" one.

So rules produce the findings: each has an id, the evidence, a line in HEAD, a
suggestion, a unit test. `--llm` talks to any OpenAI-compatible endpoint
(`SR_LLM_BASE_URL`, `SR_LLM_API_KEY`, `SR_LLM_MODEL`) to write the summary paragraph.
`tests/cli.test.ts` checks the JSON report is byte-identical with it on or off, and
that an unreachable endpoint yields the offline template rather than a failed build.

## Run against code that was not written for this tool

The demo project is a fixture: on its own it only proves the rules fire when told
to. So the rules were pointed at real repositories, in whole-directory mode, with
nothing planted for them.

| Codebase | Files | Findings | What they were |
|---|---|---|---|
| two Spring gateway modules (no MyBatis) | 195 | 3 | queries inside polling loops in `*IT.java` — real per-iteration round trips, intentional in a test |
| [abel533/MyBatis-Spring-Boot](https://github.com/abel533/MyBatis-Spring-Boot) | 24 | 2 | one `SELECT *`, one unbounded select |
| [macrozheng/mall](https://github.com/macrozheng/mall) | 638 | 29 | 15 `SELECT *`, 12 mapper calls inside batch loops, 1 unbounded select, 1 dead `@Scheduled` |
| [mybatis/mybatis-3](https://github.com/mybatis/mybatis-3) | 1837 | 581 | every one of them inside the framework's own test mappers: `SELECT *`, unbounded selects, `${}` feature tests |

The mall run found a real bug: `@Scheduled(cron = …)` on a **private** method in
`OrderTimeOutCancelTask`, which Spring will not invoke. That task does not run.

That pass produced four fixes, each pinned by a test afterwards. The first version
of MYB001 reported 84 findings on mall, all of them MyBatis Generator's own
`order by ${orderByClause}`; framework placeholders are silent now, because a rule
that fires 84 times on generated code gets the whole rule set ignored. Non-mapper
XML (`pom.xml`, `logback-spring.xml`) logged a skip per rule instead of per file. A
directory argument reported a clean run over zero files. And
`repository.findByName(name).map(e -> repository.save(e))` was read as an N+1 even
though the `Optional` runs once.

mybatis-3 was the first corpus with real MyBatis XML, and it cost four more. Its
site documentation is `<document>` XML whose `<source>` blocks quote mapper
examples — 64 findings, all of them on prose, including an injection error on
`<include refid="${include_target}"/>`, which is the documented way to choose a
fragment. Annotation SQL was scanned from the raw file, so the Javadoc of
`@Select` itself produced a `SELECT *` finding. Files with no SQL in them logged
one skip per rule again. And a `${}` that only picks an include target is a `warn`
now, not an injection `error`.

What this still does not prove: a codebase where a `${}` placeholder carries user
input. The nearest approach is mybatis-3's feature tests, where `${column}` and
`${table}` are filled from test properties — interpolated raw, correctly reported,
but nobody's request.

## What it does not do

No compiler, no classpath. Structure comes from a bracket state machine over a copy
of the file with comments and string literals blanked out, so cross-file bean wiring,
custom meta-annotations like `@MyService`, and `@Bean`-registered classes are
invisible to it ([#2](https://github.com/JingYu-create520/spring-review/issues/2)),
and a `<sql>` fragment borrowed from another mapper file is not visible to the
statement that includes it
([#3](https://github.com/JingYu-create520/spring-review/issues/3)).

When structure does not resolve, the rule stays quiet and says so under `skipped`.
That happens on Java it cannot follow, on `--patch` input for a file you do not have
locally, and on a patch whose context lines do not match the file it claims to
change; `${}` detection still works in those cases, because one line is enough to
judge.

It is not SonarQube and not Checkstyle. Formatting and code smell are not what it
looks at.

## Development

```bash
npm ci
npm run typecheck && npm test    # 125 tests
npm run build                    # dist/cli.js, dist/index.js, dist/mcp/index.js
```

`examples/demo-project` is a small order/stock app with the same mistakes planted
without labels, and two files written correctly on purpose.
`tests/demo-project.test.ts` fails if a rule stops firing there or if a clean file
starts reporting, which is what keeps the numbers in this file honest.

Layout: `src/diff` (patch → lines), `src/analyze` (Java and mapper XML structure),
`src/rules` (rules, engine, suppression), `src/report`, `src/llm`, `src/mcp`.

## License

MIT. See [LICENSE](./LICENSE).

## Also by me

- [sql-index-advisor](https://github.com/JingYu-create520/sql-index-advisor) — MySQL/MyBatis index advice from slow logs and mapper XML
- [mcp-tool-gateway](https://github.com/JingYu-create520/mcp-tool-gateway) — RBAC, audit and human confirmation in front of MCP tool calls
- [agent-regression](https://github.com/JingYu-create520/agent-regression) — regression tests for agents, in CI
- [vredis](https://github.com/JingYu-create520/vredis) — a small vector database in Rust that speaks RESP2
- [mini-search](https://github.com/JingYu-create520/mini-search) — local-first hybrid search for Chinese, hand-written analyzer
- [jvm-incident-agent](https://github.com/JingYu-create520/jvm-incident-agent) — JVM incident analysis from thread dumps, GC logs and heap histograms
