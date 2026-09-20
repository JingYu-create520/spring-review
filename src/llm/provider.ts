import type { ReviewResult } from "../types.js";
import { OpenAiCompatProvider } from "./openaiCompat.js";

/**
 * Optional polish layer. The contract, enforced by tests: the rule engine owns
 * the conclusions, the LLM only rewrites prose. Turning `--llm` on or off must
 * never change the finding set.
 *
 * Nothing in this directory is Spring-specific, so it can be copied verbatim
 * into the sibling project — change ENV_PREFIX only.
 */
export const ENV_PREFIX = "SR";
export const ENV = {
  baseUrl: `${ENV_PREFIX}_LLM_BASE_URL`,
  apiKey: `${ENV_PREFIX}_LLM_API_KEY`,
  model: `${ENV_PREFIX}_LLM_MODEL`,
} as const;

export interface LlmProvider {
  readonly name: string;
  summarize(request: SummaryRequest): Promise<string>;
}

export interface SummaryRequest {
  findings: ReviewResult["findings"];
  hitRules: string[];
  units: number;
  /** Rule id → Chinese explanation, so the model quotes our wording. */
  ruleDocs: Record<string, string>;
}

/** `null` when no endpoint is configured — callers then use the offline mock. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const baseUrl = env[ENV.baseUrl];
  if (!baseUrl) return null;
  return new OpenAiCompatProvider({
    baseUrl,
    apiKey: env[ENV.apiKey] ?? "",
    model: env[ENV.model] ?? "gpt-4o-mini",
  });
}

export { MockProvider } from "./mock.js";
export { OpenAiCompatProvider } from "./openaiCompat.js";
