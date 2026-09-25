/**
 * SERVER-ONLY provider abstraction.
 *
 * The rest of the application asks for "a completion from a model" and never
 * learns which upstream served it. Adding a provider means adding an entry to
 * PROVIDERS in pricing.server.ts plus (if its wire format differs) a branch in
 * `callModel` — no other layer changes, and the UI never changes at all.
 */

import type { ModelConfig } from "./pricing";
import { PROVIDERS } from "./pricing.server";

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

const REQUEST_TIMEOUT_MS = 120_000;

interface OpenAiCompatibleResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Calls the upstream for `model`. Never deducts, never persists — billing is
 * the caller's job and only happens once real token counts come back.
 */
export async function callModel(
  model: ModelConfig,
  messages: ProviderMessage[],
): Promise<ProviderCompletion> {
  const provider = PROVIDERS[model.provider];
  if (!provider?.enabled) throw new ProviderError("That model isn't available right now.", 503);

  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) {
    throw new ProviderError(
      "That model isn't available right now.",
      503,
      `missing env ${provider.apiKeyEnv}`,
    );
  }

  const body: Record<string, unknown> = { model: model.remoteModel, messages };
  if (model.remoteModel.startsWith("openai/gpt-5.6")) body.reasoning_effort = "none";

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(provider.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(
      "The model didn't respond in time. Please try again.",
      504,
      error instanceof Error ? error.message : "network error",
    );
  }

  const latencyMs = Date.now() - startedAt;

  if (response.status === 429) {
    throw new ProviderError("The model is busy right now. Please try again in a moment.", 429);
  }
  if (response.status === 402) {
    throw new ProviderError("AI service credits are exhausted. Please contact support.", 402);
  }
  if (!response.ok) {
    throw new ProviderError(
      "The model couldn't complete your request. Please try again.",
      502,
      `upstream ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }

  let json: OpenAiCompatibleResponse;
  try {
    json = (await response.json()) as OpenAiCompatibleResponse;
  } catch {
    throw new ProviderError("The model returned an unreadable response. Please try again.", 502);
  }

  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new ProviderError("The model returned an empty response. Please try again.", 502);
  }

  return {
    content,
    inputTokens: Math.max(0, json.usage?.prompt_tokens ?? 0),
    outputTokens: Math.max(0, json.usage?.completion_tokens ?? 0),
    cachedInputTokens: Math.max(0, json.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    cacheWriteTokens: Math.max(0, json.usage?.cache_creation_input_tokens ?? 0),
    cacheReadTokens: Math.max(0, json.usage?.cache_read_input_tokens ?? 0),
    latencyMs,
  };
}
