import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { reviewDiff, reviewPaths } from "../index.js";
import { listRules } from "../rules/index.js";
import { PACKAGE_VERSION } from "../version.js";
import type { ReviewResult, Severity } from "../types.js";

/**
 * stdio MCP server, so a coding agent can self-review the Spring/MyBatis code it
 * just wrote. Deterministic rules answer; the LLM that called us does the
 * explaining. Tool names and shapes are the public contract — additive changes
 * only.
 */
const INSTRUCTIONS = `Reviews Spring/MyBatis code for the pitfalls generic reviewers miss:
@Transactional self-invocation, missing rollbackFor, bypassed @Async/@Cacheable,
per-request thread pools, \${} SQL injection, N+1 queries, leading-wildcard LIKE,
SELECT *, unbounded selects.

Findings carry rule id, file, line in HEAD, evidence and a fix suggestion.
Severity "error" means "block the merge"; "warn" means "look at it".
Use list_rules to explain a finding in the caller's own language.`;

function options(input: { minSeverity?: string; experimental?: boolean; exclude?: string[] }) {
  return {
    minSeverity: (input.minSeverity ?? "warn") as Severity,
    experimental: Boolean(input.experimental),
    exclude: input.exclude ?? [],
  };
}

function payload(result: ReviewResult) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            summary: {
              units: result.units,
              errors: result.findings.filter((f) => f.severity === "error").length,
              warnings: result.findings.filter((f) => f.severity === "warn").length,
              hitRules: result.hitRules,
            },
            findings: result.findings,
            skipped: result.skipped,
          },
          null,
          1,
        ),
      },
    ],
  };
}

const sharedSchema = {
  minSeverity: z.enum(["error", "warn", "info"]).optional().describe("Filter before returning"),
  experimental: z.boolean().optional().describe("Include experimental rules (SPR005)"),
  exclude: z.array(z.string()).optional().describe("Glob patterns to skip"),
};

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "spring-review", version: PACKAGE_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "review_diff",
    {
      title: "Review a diff",
      description:
        "Review changed Java / MyBatis XML lines. Pass `diff` (unified patch text) or a git `range` plus `cwd`. Findings are reported only for added lines.",
      inputSchema: {
        ...sharedSchema,
        diff: z.string().optional().describe("Unified diff text"),
        range: z.string().optional().describe("git diff range, e.g. HEAD~1..HEAD"),
        cwd: z.string().optional().describe("Repository root (required for range)"),
      },
    },
    async (input) => {
      const optionsValue = options(input);
      if (typeof input.diff === "string" && input.diff.length > 0) {
        return payload(await reviewDiff({ kind: "patch", text: input.diff }, input.cwd ?? process.cwd(), optionsValue));
      }
      if (input.range) {
        const cwd = input.cwd;
        if (!cwd) {
          return {
            content: [{ type: "text" as const, text: "review_diff: `cwd` is required with `range`" }],
            isError: true,
          };
        }
        const [_, after] = input.range.split("..");
        return payload(
          await reviewDiff(
            after ? { kind: "range", range: input.range, after } : { kind: "range", range: input.range },
            cwd,
            optionsValue,
          ),
        );
      }
      return {
        content: [{ type: "text" as const, text: "review_diff: provide either `diff` or `range` + `cwd`" }],
        isError: true,
      };
    },
  );

  server.registerTool(
    "review_file",
    {
      title: "Review whole files",
      description:
        "Review complete .java / mapper .xml files (every line reportable). Accepts one path per call; paths are relative to `cwd`.",
      inputSchema: {
        ...sharedSchema,
        path: z.string().describe("File path, e.g. src/main/java/demo/UserService.java"),
        cwd: z.string().optional().describe("Repository root, defaults to the server's cwd"),
      },
    },
    async (input) =>
      payload(await reviewPaths([input.path], input.cwd ?? process.cwd(), options(input))),
  );

  server.registerTool(
    "list_rules",
    {
      title: "Rule catalogue",
      description:
        "Every rule with id, severity, Chinese/English titles and the rationale to quote when explaining a finding.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(listRules(), null, 1) }],
    }),
  );

  return server;
}

export async function startStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

const invokedDirectly = process.argv[1] && /(?:[/\\]|^)mcp[/\\]index\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  startStdio().catch((error: Error) => {
    process.stderr.write(`spring-review-mcp: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
