---
name: spring-review
description: Review Java/Spring and MyBatis code for the pitfalls generic reviewers miss — @Transactional self-invocation, missing rollbackFor, bypassed @Async/@Cacheable, per-request thread pools, ${} SQL injection, N+1 queries, leading-wildcard LIKE, SELECT *, unbounded selects. Use after writing or editing Spring Boot / MyBatis code, before committing or opening a PR, or when asked to "review this diff for Spring issues".
---

# spring-review

Deterministic rules, offline. Run it, read the findings, fix them, run it again.

## When to use this skill

1. You just created or edited a `.java` file in a Spring project, or a MyBatis `*Mapper.xml`.
2. You are about to commit, and the change touches transactions, mappers, executors or SQL.
3. The user asks why a `@Transactional` / `@Async` / `@Cacheable` annotation "does nothing".

## How to run it

Whole file (fastest feedback while editing):

```bash
npx --yes spring-review --file src/main/java/demo/UserService.java --format json
```

Your own uncommitted change, so only added lines are reported:

```bash
npx --yes spring-review --format json            # working tree vs HEAD
npx --yes spring-review --diff HEAD~1..HEAD --format json
```

Flags worth knowing: `--min-severity error|warn|info` (default `warn`),
`--experimental` (adds SPR005), `--exclude "**/generated/**"`, `--disable SPR005`,
`--format table|json|github`. Exit code: `0` nothing blocking, `1` at least one
error-severity finding, `2` the tool could not run.

## How to read the output

```json
{
  "summary": { "units": 2, "errors": 14, "warnings": 8, "hitRules": ["SPR001", "MYB001"] },
  "findings": [
    {
      "rule": "SPR001",
      "severity": "error",
      "file": "src/main/java/demo/UserService.java",
      "line": 35,
      "snippet": "this.updateName(id, name);",
      "message": "rename() 通过 this.updateName() 调用同类中带 @Transactional 的方法…",
      "messageEn": "rename() self-invokes @Transactional updateName(); the proxy never sees it…",
      "suggestion": "把 updateName() 挪到另一个 Bean…"
    }
  ]
}
```

- `line` is a line number in the file as it is now — open it there, do not re-derive it.
- `severity: error` means "do not merge this as-is". `warn` means "look at it".
- `skipped[]` entries mean the tool could not prove something (patch fragment,
  unparseable structure). Absence of a finding is not proof of correctness.

## What to do with a finding

Fix the code according to `suggestion`; the rules describe the mechanism, so the
fix is usually structural (move the method to another bean, add `rollbackFor`,
batch the query, inject an executor bean) rather than cosmetic.

Only suppress a finding when the rule genuinely does not apply, and say why —
the reason string is the audit trail:

```java
// spring-review:disable MYB001 "sortField 来自服务端白名单映射"
ORDER BY ${sortField}
```

A standalone comment suppresses the **next** line; a trailing comment suppresses
**its own** line; `// spring-review:disable-file SPR005` covers the file.

## Rules (11)

`npx spring-review --list-rules` prints the machine-readable catalogue with
rationale text — quote that when explaining a finding to the user.

| id | what it catches | severity |
| --- | --- | --- |
| SPR001 | `@Transactional` self-invocation | error |
| SPR002 | `@Transactional` without `rollbackFor` on a checked exception | error |
| SPR003 | non-public / static / self-invoked / argument-taking `@Async` `@Scheduled` | error |
| SPR004 | `new Thread` / `Executors.newXxx` inside a bean | error |
| SPR005 | mutable state on a singleton bean (`--experimental`) | warn |
| SPR006 | `@Cacheable` bypassed by self-call, or keyed by all args | warn |
| MYB001 | `${}` SQL injection (framework placeholders and ORDER BY drop to warn) | error |
| MYB002 | N+1: mapper call in a loop, or `resultMap` nested select | error |
| MYB003 | leading-wildcard LIKE, including `concat('%', …)` and `<bind>` | warn |
| MYB004 | `SELECT *` | warn |
| MYB005 | SELECT with no WHERE and no LIMIT (paged mapper methods exempt) | error |

## Limits to state honestly

No compiler, no classpath: cross-file bean wiring, custom meta-annotations and
`@Bean`-registered classes are invisible, and unusual Java syntax is skipped
rather than guessed at. It is not a replacement for SonarQube or Checkstyle —
it is the diff-time check for the Spring/MyBatis mistakes those tools do not look for.
