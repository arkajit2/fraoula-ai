/**
 * CLIENT-SAFE pricing configuration.
 *
 * Contains ONLY what the customer is charged. Provider/API costs live in
 * `pricing.server.ts` and must never be imported from client code.
 *
 * All prices are USD per 1,000,000 tokens.
 * Add a new model by adding an entry here (and its API cost in pricing.server.ts) —
 * no billing logic needs to change.
 */

export type ProviderId = "google" | "openai" | "anthropic" | "fable";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  google: "Google",
  openai: "OpenAI",
  anthropic: "Anthropic",
  fable: "Fable",
};

export interface CustomerRates {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cached input tokens. Omit when the model has no cached-input tier. */
  cachedInput?: number;
  /** USD per 1M tokens written to the prompt cache. */
  cacheWrite?: number;
  /** USD per 1M tokens read from the prompt cache. */
  cacheRead?: number;
}

export interface ModelConfig {
  id: string;
  label: string;
  provider: ProviderId;
  /** Identifier sent to the AI gateway. */
  remoteModel: string;
  /** What the customer pays (2x the provider API cost). */
  rates: CustomerRates;
  /** Free models never touch the wallet; they use the daily free allowance. */
  free: boolean;
  /** Only enabled models are selectable and routable. */
  enabled: boolean;
  /** Shown in the UI when a model is not yet available. */
  note?: string;
}

export const MODELS: ModelConfig[] = [
  {
    id: "gemini-2-5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    provider: "google",
    remoteModel: "google/gemini-2.5-flash-lite",
    rates: { input: 0, output: 0 },
    free: true,
    enabled: true,
  },
  {

    id: "gemini-3-6-flash",
    label: "Gemini 3.6 Flash",
    provider: "google",
    remoteModel: "google/gemini-3.6-flash",
    rates: { input: 3, output: 15 },
    free: false,
    enabled: true,
  },
  {
    id: "gpt-5-6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    remoteModel: "openai/gpt-5.6-luna",
    rates: { input: 2, output: 12, cachedInput: 0.2 },
    free: false,
    enabled: true,
  },
  {
    id: "gpt-5-6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    remoteModel: "openai/gpt-5.6-terra",
    rates: { input: 5, output: 30, cachedInput: 0.5 },
    free: false,
    enabled: true,
  },
  {
    id: "opus-5",
    label: "Opus 5",
    provider: "anthropic",
    remoteModel: "opus-5",
    rates: { input: 10, output: 50 },
    free: false,
    enabled: false,
    note: "Not yet available on the AI gateway",
  },
  {
    id: "fable-5",
    label: "Fable 5",
    provider: "fable",
    remoteModel: "fable-5",
    rates: { input: 20, output: 100, cacheWrite: 25, cacheRead: 2 },
    free: false,
    enabled: false,
    note: "Not yet available on the AI gateway",
  },
];

export const AVAILABLE_MODELS = MODELS.filter((m) => m.enabled);

export const DEFAULT_MODEL_ID = "gemini-2-5-flash-lite";

/**
 * Image generation is billed per image rather than per token, but follows the
 * same 2x rule: `IMAGE_API_COSTS` in pricing.server.ts holds the provider cost
 * and `pricePerImage` below is exactly twice it.
 */
export interface ImageModelConfig {
  id: string;
  label: string;
  description: string;
  provider: ProviderId;
  remoteModel: string;
  /** "openai" takes `prompt`; "gemini" takes `messages` + `modalities`. */
  wire: "openai" | "gemini";
  size?: string;
  quality?: string;
  /** What the customer pays for one generated image, in USD. */
  pricePerImage: number;
}

export const IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: "nano-banana-2",
    label: "Nano Banana 2",
    description: "Fastest and most affordable",
    provider: "google",
    remoteModel: "google/gemini-3.1-flash-image",
    wire: "gemini",
    pricePerImage: 0.02,
  },
  {
    id: "gpt-image-2",
    label: "GPT Image 2",
    description: "Balanced quality and speed",
    provider: "openai",
    remoteModel: "openai/gpt-image-2",
    wire: "openai",
    size: "1024x1024",
    quality: "low",
    pricePerImage: 0.04,
  },
  {
    id: "gemini-3-pro-image",
    label: "Gemini 3 Pro Image",
    description: "Highest detail and fidelity",
    provider: "google",
    remoteModel: "google/gemini-3-pro-image",
    wire: "gemini",
    pricePerImage: 0.12,
  },
];

export const DEFAULT_IMAGE_MODEL_ID = "gpt-image-2";

export function getImageModel(id: string): ImageModelConfig | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

/** Cheapest image, used as the minimum balance gate before generating. */
export const MIN_IMAGE_PRICE = Math.min(...IMAGE_MODELS.map((m) => m.pricePerImage));



export function getModel(id: string): ModelConfig | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Token counts for one request. Cached/cache fields are optional per model. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Generic pricing engine: charges every metered dimension the model supports.
 * Cached input tokens are billed at the cached rate and excluded from the
 * regular input rate when the model has a cached tier.
 */
export function priceUsage(rates: CustomerRates, usage: TokenUsage): number {
  const cached = rates.cachedInput != null ? (usage.cachedInputTokens ?? 0) : 0;
  const uncachedInput = Math.max(usage.inputTokens - cached, 0);

  const total =
    per1M(uncachedInput, rates.input) +
    per1M(usage.outputTokens, rates.output) +
    per1M(cached, rates.cachedInput ?? 0) +
    per1M(usage.cacheWriteTokens ?? 0, rates.cacheWrite ?? 0) +
    per1M(usage.cacheReadTokens ?? 0, rates.cacheRead ?? 0);

  return round6(total);
}

/** What the customer will be charged for this request. */
export function computeCustomerCharge(model: ModelConfig, usage: TokenUsage): number {
  return model.free ? 0 : priceUsage(model.rates, usage);
}

/** Rough client-side pre-send estimate (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Estimated charge shown before sending; assumes a ~500 token answer. */
export function estimateCharge(model: ModelConfig, prompt: string, assumedOutputTokens = 500): number {
  return computeCustomerCharge(model, {
    inputTokens: estimateTokens(prompt),
    outputTokens: assumedOutputTokens,
  });
}

export function per1M(tokens: number, pricePer1M: number): number {
  return (tokens / 1_000_000) * pricePer1M;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface CreditPackage {
  id: string;
  name: string;
  /** What the customer pays, in USD. */
  price: number;
  /** Credits added to the wallet, in USD. */
  credits: number;
  /** Checkout price identifier — the single source of truth for what a package costs. */
  priceId: string;
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  {
    id: "popular",
    name: "Starter (Popular)",
    price: 20,
    credits: 20,
    priceId: "credits_popular_onetime",
  },
  { id: "pro", name: "Pro", price: 50, credits: 50, priceId: "credits_pro_onetime" },
  { id: "business", name: "Business", price: 100, credits: 100, priceId: "credits_business_onetime" },
];

export function getCreditPackageByPriceId(priceId: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.priceId === priceId);
}


/**
 * Free tier limits. These defaults are the fallback configuration — the live
 * values are stored in the `app_settings` table under `free_tier_limits`, so an
 * administrator can change them without a redeploy. Every model flagged `free`
 * shares this allowance, so enabling another free model is a config change only.
 */
export interface FreeTierLimits {
  maxMessagesPer24h: number;
  maxRequestsPerMinute: number;
  maxInputTokensPerDay: number;
  maxOutputTokensPerDay: number;
}

export const FREE_TIER_DEFAULTS: FreeTierLimits = {
  maxMessagesPer24h: 25,
  maxRequestsPerMinute: 5,
  maxInputTokensPerDay: 20_000,
  maxOutputTokensPerDay: 40_000,
};

export const FREE_LIMIT_MESSAGE =
  "You've reached today's free usage limit. Upgrade or recharge your wallet to continue using premium models.";

export const RATE_LIMIT_MESSAGE =
  "You're sending messages too quickly on the free model. Please wait a minute and try again.";

export const INSUFFICIENT_BALANCE_MESSAGE =
  "Insufficient wallet balance. Please recharge to continue.";


export function formatUsd(value: number, digits = 2) {
  return `$${value.toFixed(digits)}`;
}

/** Small amounts (per-message costs) need more precision than 2 decimals. */
export function formatCharge(value: number) {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}


/* ------------------------------------------------------------------------- *
 * Subscription plans
 *
 * A plan does two things: it drops a monthly credit allowance into the wallet
 * and it unlocks the premium models at (or below) its tier. Credits bought as
 * one-off packages keep working exactly as before — a plan is additive.
 * ------------------------------------------------------------------------- */

export interface PlanConfig {
  id: string;
  name: string;
  /** Higher tier unlocks everything a lower tier unlocks. Tier 0 = no plan. */
  tier: number;
  /** USD per month. */
  price: number;
  /** Credits deposited on every successful monthly payment, in USD. */
  monthlyCredits: number;
  /** Recurring checkout price identifier. */
  priceId: string;
  highlights: string[];
}

/** Everyone, including users without a subscription. */
export const FREE_PLAN: PlanConfig = {
  id: "free",
  name: "Pay as you go",
  tier: 0,
  price: 0,
  monthlyCredits: 0,
  priceId: "",
  highlights: ["Free model with a daily allowance", "Buy credit packs any time"],
};

export const PLANS: PlanConfig[] = [
  {
    id: "plus",
    name: "Plus",
    tier: 1,
    price: 19,
    monthlyCredits: 20,
    priceId: "plan_plus_monthly",
    highlights: ["$20 of credits every month", "Standard premium models", "Cancel any time"],
  },
  {
    id: "pro",
    name: "Pro",
    tier: 2,
    price: 49,
    monthlyCredits: 55,
    priceId: "plan_pro_monthly",
    highlights: ["$55 of credits every month", "All premium models", "Priority model access"],
  },
  {
    id: "business",
    name: "Business",
    tier: 3,
    price: 149,
    monthlyCredits: 170,
    priceId: "plan_business_monthly",
    highlights: ["$170 of credits every month", "All premium models", "Highest usage limits"],
  },
];

export function getPlan(planId?: string | null): PlanConfig {
  return PLANS.find((p) => p.id === planId) ?? FREE_PLAN;
}

export function getPlanByPriceId(priceId: string): PlanConfig | undefined {
  return PLANS.find((p) => p.priceId === priceId);
}

/**
 * Minimum plan tier required for a model. Anything not listed is available to
 * everyone on pay-as-you-go credits, so adding a model stays a config change.
 */
export const MODEL_MIN_TIER: Record<string, number> = {
  "gpt-5-6-terra": 1,
  "opus-5": 2,
  "fable-5": 2,
};

export function modelMinTier(modelId: string): number {
  return MODEL_MIN_TIER[modelId] ?? 0;
}

/** Lowest plan that unlocks this model, or undefined when it's open to all. */
export function planRequiredForModel(modelId: string): PlanConfig | undefined {
  const tier = modelMinTier(modelId);
  return tier === 0 ? undefined : PLANS.find((p) => p.tier >= tier);
}

export function canUseModel(modelId: string, planId?: string | null): boolean {
  return getPlan(planId).tier >= modelMinTier(modelId);
}

export const PLAN_REQUIRED_MESSAGE = "That model is included with a subscription plan. Upgrade on the Credits page to use it.";
