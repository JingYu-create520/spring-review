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

Rules make these calls. The engine is offline, needs no API key, and prints the same
output for the same diff. `--llm` rewrites the summary paragraph and nothing else; a
test asserts that turning it on cannot move a single finding.

![spring-review reviewing examples/demo-project: 6 errors and 2 warnings, each with a rule id, a line number, the offending code and a fix](./docs/assets/demo.png)

*Run against `examples/demo-project` in this repo. No API key, no network.*

> [中文 README](./README.zh-CN.md) · [Rules](#the-rules-11) · [Why not just ask the model](#why-not-just-ask-the-model) · [Limitations](#what-it-does-not-do)

Exit code is the CI contract: **0** nothing blocking, **1** at least one `error`,
**2** the tool could not run.

### See it on code that isn't a test fixture

[`examples/demo-project`](./examples/demo-project) is a small, deliberately ordinary
Spring Boot + MyBatis app — orders, stock, price rules — with the mistakes planted
where they occur in real projects and no `// SPR001 here` labels. Two files in it are
written the right way and must come back silent; `tests/demo-project.test.ts` fails
CI if any of that stops being true.

```bash
node dist/cli.js --cwd examples/demo-project --experimental \
  --file $(cd examples/demo-project && find src -name '*.java' -o -name '*.xml')
```

20 findings, all 11 rules represented, zero on the clean files. The table in that
folder explains why each planted case is worth a rule.

## Install

The npm package is not published yet, so today you run it from a clone — it takes
about 30 seconds and needs nothing but Node 20+:

```bash
git clone https://github.com/JingYu-create520/spring-review.git
cd spring-review
npm ci && npm run build
node dist/cli.js --patch examples/sample.patch     # try it on our demo diff
```

Reviewing your own project, from inside it:

```bash
node /path/to/spring-review/dist/cli.js --diff HEAD~1..HEAD
node /path/to/spring-review/dist/cli.js --file src/main/java/demo/UserService.java
```

Once the package is on npm this becomes `npm i -D spring-review` / `npx spring-review`,
and every command below keeps working unchanged.

## Four ways to use it

**1 · CLI, before you commit**

```bash
# until the package is published, treat spring-review as an alias for: node dist/cli.js
spring-review                             # uncommitted changes
spring-review --diff origin/main..HEAD    # a range
spring-review --staged
spring-review --file src/main/java/demo/UserService.java
spring-review --patch pr.patch --format github
```

**2 · GitHub Action, on every PR**

*(needs the npm package, so it lights up the day it is published — until then run
the CLI in a plain `script:` step against your clone)*

```yaml
# .github/workflows/spring-review.yml
on: [pull_request]
permissions: { contents: read, checks: write }
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: JingYu-create520/spring-review@v0.1.0
        with:
          exclude: "**/generated/**"
```

Findings land as check-run annotations, i.e. inline comments on the diff, with no
API token and no comment threads to de-duplicate. Set `fail-on-error: false` to
annotate without blocking — it emits the same annotations at `notice` level, since
a `::error` workflow command fails the job on its own no matter what the exit code is.

**2b · GitHub Code Scanning** — `--format sarif` emits SARIF 2.1.0 with all 11 rule
descriptions embedded, so findings become persistent alerts on the Security tab
instead of annotations that scroll away:

```yaml
- run: spring-review --diff origin/main..HEAD --format sarif > spring-review.sarif
- uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: spring-review.sarif, category: spring-review }
```

This repo does exactly that against `tests/fixtures` on every push to `main`, so
you can see live alerts before trusting it on your own code.

**3 · MCP server, for your coding agent**

Point it at your clone (works today):

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

Once the package is on npm:

```json
{
  "mcpServers": {
    "spring-review": { "command": "npx", "args": ["-y", "spring-review", "mcp"] }
  }
}
```

Tools: `review_diff` (patch text or a git range), `review_file`, `list_rules`.
The agent writes the Spring code, runs the review itself, and fixes what it broke —
with no model call inside the judgement, so results are reproducible.

**4 · Agent Skill**

`skills/spring-review/SKILL.md` teaches a skill-aware agent when to run the CLI and
how to read `findings[]`. Install by copying it into your skills directory.

## The rules (11)

`spring-review --list-rules` prints them with rationale text, machine-readable.

### Spring

| ID | Catches | Severity |
| --- | --- | --- |
| **SPR001** | `@Transactional` self-invocation: the proxy never sees `this.m()` or a bare `m()` | error |
| **SPR002** | `@Transactional` on a method that `throws` a checked exception with no `rollbackFor` — the half-finished write commits | error |
| **SPR003** | `@Async` / `@Scheduled` that can never fire: non-public, static, self-invoked, or `@Scheduled` with arguments | error |
| **SPR004** | `new Thread(...)` / `Executors.newXxx(...)` inside a singleton bean — unbounded threads, no graceful shutdown | error |
| **SPR005** | mutable instance state written from unguarded methods (behind `--experimental`) | warn |
| **SPR006** | `@Cacheable` bypassed by a self-call, or keyed by all arguments with no `key` | warn |

### MyBatis

| ID | Catches | Severity |
| --- | --- | --- |
| **MYB001** | `${}` string interpolation in mapper XML **and** `@Select` SQL. MyBatis-Plus `${ew.customSqlSegment}` and dynamic `ORDER BY` become `warn` with a whitelist suggestion instead of noise | error |
| **MYB002** | N+1: a mapper call inside `for` / `while` / `forEach` / `stream().map()`, or a `resultMap` nested `<association select>` | error |
| **MYB003** | leading-wildcard `LIKE` — the literal, the `concat('%', #{x}, '%')` and the `<bind value="'%' + …">` forms | warn |
| **MYB004** | `SELECT *` (never `count(*)`) | warn |
| **MYB005** | `SELECT` with no `WHERE` and no `LIMIT`, exempting `IPage` / PageHelper pagination read from the mapper interface | error |

## Why not just ask the model

Three things a model does not do with a diff. It cannot give you a line number you
can click. It cannot promise the same answer twice, so it cannot gate a merge. And it
does not know that `ORDER BY ${sortField}` is a whitelist problem rather than a "use
`#{}`" one — a column name cannot be bound, so the obvious advice is the wrong advice.

So rules produce the findings. Each carries an id, the evidence, a line in HEAD, a
suggestion, and a unit test. `--llm` is for the summary paragraph only, against any
OpenAI-compatible endpoint (`SR_LLM_BASE_URL` / `SR_LLM_API_KEY` / `SR_LLM_MODEL`).
`tests/cli.test.ts` checks that the JSON report is byte-identical with `--llm` on or
off, and that an unreachable endpoint returns the offline template plus a note instead
of failing the build.

## What it does not do

There is no compiler and no classpath here. Structure comes from a bracket state
machine running over a copy of the file with comments and string literals blanked
out, so it cannot see cross-file bean wiring, custom meta-annotations like
`@MyService`, or classes registered through `@Bean`.

When structure does not resolve, the rule stays quiet. That happens on Java it cannot
follow, and on `--patch` input where the file is not on your disk: the
context-hungry rules skip and record why under `skipped`, while `${}` detection still
works because one line is enough to judge it.

To silence a finding, put `// spring-review:disable SPR001 "reason"` on the offending
line or the line above, use `disable-file` for a whole file, or turn rules off per
repo in `.spring-review.json`.

It is not SonarQube and it is not Checkstyle. Formatting and code smell are not what
it looks at.

## Development

```bash
npm ci
npm run typecheck && npm test     # 105 tests: parser, each rule, false-positive guards,
                                 # CLI, MCP (in-memory + real stdio), golden output
npm run build                     # dist/cli.js, dist/index.js, dist/mcp/index.js
```

Layout: `src/diff` (patch → lines), `src/analyze` (Java / mapper XML structure),
`src/rules` (11 rules + engine + suppression), `src/report`, `src/llm`, `src/mcp`.

## License

MIT — see [LICENSE](./LICENSE).

## More from this author

- `sql-index-advisor` — offline index advisor for MySQL / MyBatis
- `mcp-tool-gateway` — RBAC, audit trail and human-in-the-loop for MCP tool calls
- `agent-regression` — trace, score and block agent regressions in CI
