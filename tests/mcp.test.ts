import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/index.js";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

async function linkedClient(): Promise<Client> {
  const server = createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const text = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  return (content ?? []).map((c) => c.text ?? "").join("\n");
};

describe("MCP server tool surface", () => {
  it("advertises review_diff, review_file and list_rules", async () => {
    const client = await linkedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_rules", "review_diff", "review_file"]);
    const reviewDiff = tools.find((t) => t.name === "review_diff")!;
    expect(Object.keys(reviewDiff.inputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(["diff", "range", "cwd", "minSeverity", "experimental"]),
    );
    await client.close();
  });

  it("list_rules explains the rules so an agent can quote them", async () => {
    const client = await linkedClient();
    const result = await client.callTool({ name: "list_rules", arguments: {} });
    const docs = JSON.parse(text(result)) as Array<{ id: string; rationale: string }>;
    expect(docs).toHaveLength(11);
    expect(docs.find((d) => d.id === "SPR001")!.rationale).toContain("代理");
    await client.close();
  });

  it("review_file returns line-level findings for a Spring service", async () => {
    const client = await linkedClient();
    const result = await client.callTool({
      name: "review_file",
      arguments: { path: "java/BadUserService.java", cwd: fixtures },
    });
    const payload = JSON.parse(text(result)) as {
      summary: { errors: number; hitRules: string[] };
      findings: Array<{ rule: string; file: string; line: number; snippet: string }>;
    };
    expect(payload.summary.errors).toBeGreaterThan(0);
    expect(payload.summary.hitRules).toContain("SPR001");
    const hit = payload.findings.find((f) => f.rule === "SPR001")!;
    expect(hit.file).toBe("java/BadUserService.java");
    expect(hit.snippet).toContain("this.updateName");
    await client.close();
  });

  it("review_diff works on patch text with no repository at all", async () => {
    const client = await linkedClient();
    const java = readFileSync(join(fixtures, "java", "BadUserService.java"), "utf8").split("\n");
    const diff = [
      "--- /dev/null",
      "+++ b/src/main/java/demo/BadUserService.java",
      `@@ -0,0 +1,${java.length} @@`,
      ...java.map((l) => `+${l}`),
    ].join("\n");
    const result = await client.callTool({ name: "review_diff", arguments: { diff } });
    const payload = JSON.parse(text(result)) as {
      summary: { hitRules: string[] };
      findings: Array<{ rule: string; line: number }>;
    };
    expect(payload.summary.hitRules).toContain("SPR001");
    expect(payload.findings.find((f) => f.rule === "SPR001")!.line).toBeGreaterThan(1);
    await client.close();
  });

  it("asks for the missing argument instead of guessing a repository", async () => {
    const client = await linkedClient();
    const result = await client.callTool({
      name: "review_diff",
      arguments: { range: "HEAD~1..HEAD" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).toContain("cwd");
    await client.close();
  });

  it("returns an empty finding set for clean code", async () => {
    const client = await linkedClient();
    const result = await client.callTool({
      name: "review_file",
      arguments: { path: "java/CleanUserService.java", cwd: fixtures, experimental: true },
    });
    const payload = JSON.parse(text(result)) as { findings: unknown[] };
    expect(payload.findings).toEqual([]);
    await client.close();
  });
});

describe("stdio transport (the form Claude and Qoder actually launch)", () => {
  const entry = resolve(here, "..", "dist", "cli.js");

  it(
    "answers initialize + tools/list over real stdio via `spring-review mcp`",
    async () => {
      if (!existsSync(entry)) return; // `npm run build` first; source tests cover the logic
      const child = spawn(process.execPath, [entry, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
      const buffer: string[] = [];
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => buffer.push(...chunk.split("\n").filter(Boolean)));
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
      const first = await waitFor(buffer, 1);
      const initialized = JSON.parse(first) as { result: { serverInfo: { name: string } } };
      expect(initialized.result.serverInfo.name).toBe("spring-review");

      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listed = JSON.parse(await waitFor(buffer, 2)) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listed.result.tools.map((t) => t.name).sort()).toEqual([
        "list_rules",
        "review_diff",
        "review_file",
      ]);

      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "review_file", arguments: { path: "java/BadUserService.java", cwd: fixtures } },
      });
      const called = JSON.parse(await waitFor(buffer, 3)) as {
        result: { content: Array<{ text: string }> };
      };
      expect(called.result.content[0]!.text).toContain("SPR001");
      child.kill();
    },
    30_000,
  );
});

/** MCP stdio replies in order, so waiting for id N means everything before it arrived. */
function waitFor(lines: string[], id: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = lines.find((line) => {
        try {
          return JSON.parse(line).id === id;
        } catch {
          return false;
        }
      });
      if (found) {
        clearInterval(tick);
        resolvePromise(found);
      } else if (Date.now() - started > 20_000) {
        clearInterval(tick);
        reject(new Error(`no reply for id ${id}; got: ${lines.join(" | ").slice(0, 400)}`));
      }
    }, 25);
  });
}
