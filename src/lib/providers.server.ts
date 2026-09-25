/**
 * SERVER-ONLY provider abstraction.
 *
 * The rest of the application asks for "a completion from a model" and never
 * learns which upstream served it. Cloudflare Workers AI is called via the
 * Worker binding (`ai`) that is passed into `callModel` — no API keys, no HTTP
 * fetch, no gateway endpoints required.
 */

import type { ModelConfig } from "./pricing";

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderCompletion {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Upstream round-trip in milliseconds, for latency monitoring. */
  latencyMs: number;
}

/** Provider-layer failure. Carries a safe, user-facing message only. */
export class ProviderError extends Error {
  readonly status: number;
  /** Internal-only detail; logged, never returned to the client. */
  readonly detail?: string;

  constructor(message: string, status = 502, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Minimal interface for the Cloudflare Workers AI binding.
 * The actual `Ai` type from `@cloudflare/workers-types` is a superset of this.
 */
interface CfAiBinding {
  run(
    model: string,
    inputs: { messages: Array<{ role: string; content: string }> },
  ): Promise<{ response?: string; [key: string]: unknown }>;
}

/**
 * Calls the Cloudflare Workers AI binding for `model`. Never deducts, never
 * persists — billing is the caller's job and only happens once real token
 * counts come back.
 *
 * Token counts are estimated (~4 chars per token) because the CF AI binding
 * does not currently return usage metadata.
 */
export async function callModel(
  model: ModelConfig,
  messages: ProviderMessage[],
  ai: CfAiBinding,
): Promise<ProviderCompletion> {
  const start = Date.now();

  let result: { response?: string; [key: string]: unknown };
  try {
    result = await ai.run(model.remoteModel, { messages });
  } catch (error) {
    throw new ProviderError(
      "The model didn't respond in time. Please try again.",
      504,
      error instanceof Error ? error.message : "CF AI binding error",
    );
  }

  const latencyMs = Date.now() - start;

  const content = typeof result.response === "string" ? result.response.trim() : "";
  if (!content) {
    throw new ProviderError("The model returned an empty response. Please try again.", 502);
  }

  // Estimate token counts: ~4 characters per token (CF AI does not expose usage).
  const inputTokens = Math.ceil(
    messages.reduce((acc, m) => acc + m.content.length, 0) / 4,
  );
  const outputTokens = Math.ceil(content.length / 4);

  return {
    content,
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    latencyMs,
  };
}
