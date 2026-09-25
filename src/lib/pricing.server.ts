/**
 * SERVER-ONLY pricing configuration.
 *
 * Provider API costs and endpoints. Never import this from client code —
 * customers must never see raw provider pricing or key names.
 */

import {
  getModel,
  priceUsage,
  round6,
  type CustomerRates,
  type ModelConfig,
  type ProviderId,
  type TokenUsage,
} from "./pricing";

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  endpoint: string;
  apiKeyEnv: string;
  enabled: boolean;
}

/** All enabled models currently route through the managed AI gateway. */
const GATEWAY_ENDPOINT = "https://ai.gateway.lovable.dev/v1/chat/completions";

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  google: { id: "google", label: "Google", endpoint: GATEWAY_ENDPOINT, apiKeyEnv: "LOVABLE_API_KEY", enabled: true },
  openai: { id: "openai", label: "OpenAI", endpoint: GATEWAY_ENDPOINT, apiKeyEnv: "LOVABLE_API_KEY", enabled: true },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    enabled: false,
  },
  fable: {
    id: "fable",
    label: "Fable",
    endpoint: GATEWAY_ENDPOINT,
    apiKeyEnv: "LOVABLE_API_KEY",
    enabled: false,
  },
};

/** Provider API cost, USD per 1M tokens. Customer pricing is exactly 2x these. */
export const API_RATES: Record<string, CustomerRates> = {
  "gemini-3-6-flash": { input: 1.5, output: 7.5 },
  "gpt-5-6-luna": { input: 1, output: 6, cachedInput: 0.1 },
  "gpt-5-6-terra": { input: 2.5, output: 15, cachedInput: 0.25 },
  "opus-5": { input: 5, output: 25 },
  "fable-5": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
};

/** Provider cost for one generated image, USD. Customers pay exactly 2x these. */
export const IMAGE_API_COSTS: Record<string, number> = {
  "nano-banana-2": 0.01,
  "gpt-image-2": 0.02,
  "gemini-3-pro-image": 0.06,
};

/** Endpoint used for image generation on the managed AI gateway. */
export const IMAGE_ENDPOINT = "https://ai.gateway.lovable.dev/v1/images/generations";


export interface BillingBreakdown {
  /** What the provider charges us. */
  apiCost: number;
  /** Platform margin (customer charge - api cost). */
  platformMarkup: number;
  /** What the customer is charged. */
  customerCharge: number;
}

/** Generic: works for any model in the config, no per-model branching. */
export function computeBilling(model: ModelConfig, usage: TokenUsage): BillingBreakdown {
  if (model.free) return { apiCost: 0, platformMarkup: 0, customerCharge: 0 };

  const apiRates = API_RATES[model.id];
  const apiCost = apiRates ? priceUsage(apiRates, usage) : 0;
  const customerCharge = priceUsage(model.rates, usage);

  return {
    apiCost: round6(apiCost),
    platformMarkup: round6(customerCharge - apiCost),
    customerCharge: round6(customerCharge),
  };
}

export function getRoutableModel(id: string): ModelConfig | undefined {
  const model = getModel(id);
  if (!model || !model.enabled) return undefined;
  return PROVIDERS[model.provider].enabled ? model : undefined;
}
