/**
 * SERVER-ONLY pricing configuration.
 *
 * Internal Cloudflare Workers AI costs and billing helpers. Never import this
 * from client code — customers must never see raw provider pricing.
 *
 * All costs are USD per 1,000,000 tokens. Customer rates (2x) live in
 * `pricing.ts`; only the raw CF costs are tracked here for margin reporting.
 */

import type { ModelConfig, TokenUsage } from "./pricing";
import { priceUsage, round6, per1M } from "./pricing";

export const PROVIDERS = {
  cloudflare: {
    label: "Cloudflare AI",
    enabled: true,
    /** Internal CF AI costs (USD per 1M tokens) — for cost tracking only. */
    costs: {
      "llama-3-1-8b":      { input: 0,    output: 0    },
      "llama-3-2-3b":      { input: 0,    output: 0    },
      "llama-3-3-70b":     { input: 0.50, output: 1.50 },
      "deepseek-v4-flash": { input: 0.50, output: 1.50 },
      "gpt-oss-20b":       { input: 2.00, output: 6.00 },
      "deepseek-r1-32b":   { input: 2.00, output: 6.00 },
      "qwq-32b":           { input: 2.00, output: 6.00 },
      "deepseek-v4-pro":   { input: 5.00, output: 15.00 },
      "gpt-oss-120b":      { input: 5.00, output: 15.00 },
      "kimi-k2":           { input: 3.00, output: 9.00 },
      "nvidia-nemotron":   { input: 5.00, output: 15.00 },
      "llama-4-scout":     { input: 1.00, output: 3.00 },
    } as Record<string, { input: number; output: number }>,
  },
} as const;

export function computeBilling(
  model: ModelConfig,
  usage: TokenUsage,
): { apiCost: number; platformMarkup: number; customerCharge: number } {
  const providerCosts = PROVIDERS.cloudflare.costs[model.id] ?? { input: 0, output: 0 };
  const apiCost = round6(
    per1M(usage.inputTokens ?? 0, providerCosts.input) +
    per1M(usage.outputTokens ?? 0, providerCosts.output),
  );
  const customerCharge = model.free ? 0 : round6(priceUsage(model.rates, usage));
  const platformMarkup = round6(customerCharge - apiCost);
  return { apiCost, platformMarkup, customerCharge };
}
