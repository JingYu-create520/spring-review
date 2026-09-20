import type { LlmProvider, SummaryRequest } from "./provider.js";

export interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Milliseconds; a hung endpoint must never hang CI. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Any OpenAI-compatible `/chat/completions` endpoint: OpenAI, DeepSeek,
 * Moonshot, Ollama, vLLM, an internal gateway. Plain `fetch`, no SDK, so the
 * dependency budget stays where the plan put it.
 *
 * Failures degrade to the offline summary — `--llm` is a nicety, not a build
 * dependency.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly name = "openaiCompat";

  constructor(private readonly config: OpenAiCompatConfig) {}

  async summarize(request: SummaryRequest): Promise<string> {
    const body = {
      model: this.config.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: [
            "你是资深 Java 后端工程师,在帮同事读 PR。",
            "只根据给定的规则发现写一段简短的 PR 评论(中文,不超过 8 行)。",
            "不得新增、删除或修改任何发现,不得编造未在列表中的问题。",
            "语气具体、可执行,不要客套话。",
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify(toPromptPayload(request), null, 1) },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
    const doFetch = this.config.fetchImpl ?? fetch;
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    try {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("empty completion");
      return text;
    } catch (error) {
      const reason = (error as Error).name === "AbortError" ? "timed out" : (error as Error).message;
      // Keep the run usable; surface the reason on stderr via the returned note.
      return `[LLM 总结不可用:${reason} — 以下为离线模板]`;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toPromptPayload(request: SummaryRequest) {
  return {
    filesReviewed: request.units,
    rules: request.ruleDocs,
    findings: request.findings.map((f) => ({
      rule: f.rule,
      severity: f.severity,
      file: f.file,
      line: f.line,
      message: f.message,
    })),
  };
}
