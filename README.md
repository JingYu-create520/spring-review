# spring-review

**Git diff in, line-level findings out — for the Spring & MyBatis bugs generic AI code review cannot see.**

`@Transactional` that silently does nothing, an N+1 hiding in a `for` loop, a `${}`
that makes your WHERE clause injectable, a thread pool created per request. These
are not style problems, they are "works in dev, melts in production" problems, and
they are invisible to tools tuned on Java syntax rather than Spring *semantics*.

A deterministic rule engine makes the call — offline, no API key, same input every
time, exact line numbers, unit-testable. An LLM is only ever asked to reword the
summary, never to decide.

> [中文 README](./README.zh-CN.md) · [Rules](#the-rules-11) · [Why not just ask the model](#why-not-just-ask-the-model) · [Limitations](#what-it-does-not-do)

```console
$ node dist/cli.js --patch examples/sample.patch

src/main/java/demo/BadUserService.java
  src/main/java/demo/BadUserService.java:35  error  SPR001  rename() 通过 this.updateName(),而该方法带 @Transactional —— 代理不拦截自调用…
      this.updateName(id, name);
      → 把 updateName() 挪到另一个 Bean,或注入自身代理后再调用(@Lazy 注入本类 / AopContext.currentProxy())。
  src/main/java/demo/BadUserService.java:45  error  SPR002  importUsers() 声明抛出受检异常 IOException,但 @Transactional
      @Transactional
      → @Transactional(rollbackFor = Exception.class)
  src/main/java/demo/BadUserService.java:48  error  MYB002  importUsers() 在 for 循环中调用 userMapper.insertOne(),
      userMapper.insertOne(user);
      → 先收集 id 一次性查:selectByIds(ids) 或 IN (…) 批量查,再 Map<id, X> 组装。
  src/main/resources/mapper/BadUserMapper.xml:14  error  MYB001  select#byName 用 ${keyword} 拼接 SQL…
      WHERE user_name = '${keyword}'
      → 改为预编译参数 #{keyword}。

14 error(s)  8 warning(s)  across 2 file(s), rules hit: MYB001, MYB002, MYB003, MYB004, MYB005, SPR001…
```

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
about 30 seconds and needs nothing but Node 18+:

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

```json
{
  "mcpServers": {
    "spring-review": { "command": "npx", "args": ["-y", "spring-review", "mcp"] }
  }
}
```

Works today without npm, pointing at your clone:

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

Because a model reading a diff cannot tell you *which line* to open, cannot promise
the same answer twice, and has no idea that your `ORDER BY ${sortField}` is a
whitelist problem rather than an injection one.

The split is deliberate:

- **Rules own the conclusions.** Every finding has an id, an evidence snippet, a
  line in HEAD and a suggested fix. Unit-tested, reproducible, runs on a plane.
- **The LLM owns the prose.** `--llm` rewrites the summary paragraph against any
  OpenAI-compatible endpoint (`SR_LLM_BASE_URL` / `SR_LLM_API_KEY` /
  `SR_LLM_MODEL`). A test asserts the finding set is byte-identical with it on or
  off, and an unreachable endpoint degrades to the offline template instead of
  failing your build.

## What it does not do

Written to be honest about its edge, because a review tool earns or loses its
reputation on false positives:

- **No compiler, no classpath.** Structure comes from a bracket state machine over a
  comment/string-masked copy of the file, so cross-file bean wiring, custom
  meta-annotations (`@MyService`) and `@Bean`-registered classes are invisible.
- **It skips instead of guessing.** Unparseable structure, or a `--patch` whose file
  you do not have locally, means the context-hungry rules stay quiet and say so
  under `skipped`. Token-level `${}` detection still works on fragments.
- **`suppress` is available but blunt**: `// spring-review:disable SPR001 "reason"`
  on the offending line or the line above, `disable-file` for a whole file,
  `.spring-review.json` to turn rules off per repo.
- **Not a replacement for SonarQube or Checkstyle.** It does not look for code smell
  or formatting; it looks for the Spring/MyBatis mistakes those do not check, at
  diff time, in seconds.

## Development

```bash
npm ci
npm run typecheck && npm test     # 98 tests: parser, each rule, false-positive guards,
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
