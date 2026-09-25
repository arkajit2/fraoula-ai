/**
 * Chat server — Cloudflare D1 + Workers AI edition.
 *
 * Replaces the Supabase-backed version. All DB access goes through D1,
 * all AI calls go through the Workers AI binding (env.AI). No external
 * API keys required; auth is now JWT-based via auth.server.ts.
 */

import type { ModelConfig, TokenUsage } from "./pricing";
import {
  computeCustomerCharge,
  getModel,
  modelMinTier,
  canUseModel,
  PLAN_REQUIRED_MESSAGE,
  INSUFFICIENT_BALANCE_MESSAGE,
  FREE_LIMIT_MESSAGE,
  RATE_LIMIT_MESSAGE,
  round6,
} from "./pricing";
import { computeBilling } from "./pricing.server";
import { callModel, ProviderError } from "./providers.server";
import type { CfAiBinding } from "./providers.server";
import {
  getWallet,
  createWallet,
  updateWalletBalance,
  getConversation,
  createConversation,
  getMessages,
  insertMessages,
  recordUsage,
  getFreeUsageToday,
  incrementFreeUsage,
  getAppSetting,
  getSubscription,
} from "./db.server";

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  maxMessageLength: 32_000,
  historyLimit: 40,
  titleLength: 80,
  minPremiumBalanceUsd: 0.001,
  systemPrompt:
    "You are a helpful, concise, and friendly AI assistant. Reply clearly and directly.",
  freeTierDefaults: {
    maxMessagesPer24h: 25,
    maxInputTokensPerDay: 20_000,
    maxOutputTokensPerDay: 40_000,
  },
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SendMessageInput {
  content: string;
  modelId: string;
  conversationId?: string | null;
}

export interface SendMessageResult {
  conversationId: string;
  userMessageId: string;
  assistantMessage: {
    id: string;
    content: string;
    created_at: string;
  };
  balance: number;
  cost: number;
  usage: Required<TokenUsage>;
}

export class ChatError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ─── Env interface ───────────────────────────────────────────────────────────

export interface WorkerEnv {
  DB: D1Database;
  AI: CfAiBinding;
  FRAOULA_CACHE?: KVNamespace;
}

// ─── Rate limiting (KV-based) ────────────────────────────────────────────────

async function enforceRateLimit(
  kv: KVNamespace | undefined,
  userId: string,
  key: string,
  limit: number,
  windowSecs: number,
): Promise<void> {
  if (!kv) return; // skip in dev
  const kvKey = `rl:${key}:${userId}`;
  const raw = await kv.get(kvKey);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) {
    throw new ChatError(RATE_LIMIT_MESSAGE, 429);
  }
  await kv.put(kvKey, String(count + 1), { expirationTtl: windowSecs });
}

// ─── Free tier enforcement ───────────────────────────────────────────────────

async function assertFreeAllowance(
  db: D1Database,
  userId: string,
): Promise<void> {
  // Load live limits from app_settings (falls back to defaults)
  let limits = CONFIG.freeTierDefaults;
  try {
    const raw = await getAppSetting(db, "free_tier_limits");
    if (raw) limits = { ...limits, ...JSON.parse(raw) };
  } catch {
    /* use defaults */
  }

  const today = await getFreeUsageToday(db, userId);
  if (today && today.messages_count >= limits.maxMessagesPer24h) {
    throw new ChatError(FREE_LIMIT_MESSAGE, 429);
  }
  if (today && today.input_tokens >= limits.maxInputTokensPerDay) {
    throw new ChatError(FREE_LIMIT_MESSAGE, 429);
  }
}

// ─── Main send function ───────────────────────────────────────────────────────

export async function sendMessage(
  env: WorkerEnv,
  userId: string,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const { DB: db, AI: ai, FRAOULA_CACHE: kv } = env;

  const content = input.content.trim();
  if (!content) throw new ChatError("Message cannot be empty.");
  if (content.length > CONFIG.maxMessageLength)
    throw new ChatError("Message is too long.");

  const model = getModel(input.modelId);
  if (!model || !model.enabled)
    throw new ChatError("That model isn't available right now.");

  // Rate limits: burst (10/min) and sustained (60/hr)
  await enforceRateLimit(kv, userId, "burst", 10, 60);
  await enforceRateLimit(kv, userId, "sustained", 60, 3600);

  // ── Ownership check ────────────────────────────────────────────────────────
  if (input.conversationId) {
    const convo = await getConversation(db, input.conversationId, userId);
    if (!convo) throw new ChatError("Conversation not found.", 404);
  }

  // ── Plan / entitlement ────────────────────────────────────────────────────
  if (modelMinTier(model.id) > 0) {
    const sub = await getSubscription(db, userId);
    if (!canUseModel(model.id, sub?.plan_id)) {
      throw new ChatError(PLAN_REQUIRED_MESSAGE, 402);
    }
  }

  // ── Balance / allowance check ─────────────────────────────────────────────
  if (model.free) {
    await assertFreeAllowance(db, userId);
  } else {
    let wallet = await getWallet(db, userId);
    if (!wallet) wallet = await createWallet(db, userId);
    if (wallet.balance < CONFIG.minPremiumBalanceUsd) {
      throw new ChatError(INSUFFICIENT_BALANCE_MESSAGE, 402);
    }
  }

  // ── Conversation history ──────────────────────────────────────────────────
  const history: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  if (input.conversationId) {
    const rows = await getMessages(db, input.conversationId, CONFIG.historyLimit);
    for (const m of rows) {
      history.push({ role: m.role as "user" | "assistant", content: m.content });
    }
  }

  // ── AI call ───────────────────────────────────────────────────────────────
  let completion: Awaited<ReturnType<typeof callModel>>;
  try {
    completion = await callModel(
      model,
      [
        { role: "system", content: CONFIG.systemPrompt },
        ...history,
        { role: "user", content },
      ],
      ai,
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ChatError(error.message, error.status);
    }
    throw error;
  }

  const usage: Required<TokenUsage> = {
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    cachedInputTokens: completion.cachedInputTokens,
    cacheWriteTokens: completion.cacheWriteTokens,
    cacheReadTokens: completion.cacheReadTokens,
  };

  const { apiCost, platformMarkup, customerCharge } = computeBilling(model, usage);

  // ── Create conversation if new ────────────────────────────────────────────
  let conversationId = input.conversationId;
  if (!conversationId) {
    const convo = await createConversation(
      db,
      userId,
      content.slice(0, CONFIG.titleLength),
    );
    conversationId = convo.id;
  }

  // ── Billing settlement ────────────────────────────────────────────────────
  let balance: number;
  if (model.free) {
    await incrementFreeUsage(db, userId, usage.inputTokens, usage.outputTokens);
    const wallet = await getWallet(db, userId);
    balance = wallet?.balance ?? 0;
  } else {
    balance = await deductFromWallet(db, userId, customerCharge);
  }

  // ── Record usage ──────────────────────────────────────────────────────────
  await recordUsage(db, {
    user_id: userId,
    provider: "Cloudflare AI",
    model: model.label,
    conversation_id: conversationId,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    cache_read_tokens: usage.cacheReadTokens,
    api_cost: apiCost,
    platform_markup: platformMarkup,
    final_cost: customerCharge,
  });

  // ── Persist messages ──────────────────────────────────────────────────────
  const now = new Date();
  const askedAt = now.toISOString();
  const answeredAt = new Date(now.getTime() + 1).toISOString();

  const written = await insertMessages(db, [
    { conversation_id: conversationId, role: "user", content, created_at: askedAt },
    {
      conversation_id: conversationId,
      role: "assistant",
      content: completion.content,
      created_at: answeredAt,
    },
  ]);

  const userMsg = written.find((m) => m.role === "user")!;
  const assistantMsg = written.find((m) => m.role === "assistant")!;

  return {
    conversationId,
    userMessageId: userMsg.id,
    assistantMessage: {
      id: assistantMsg.id,
      content: assistantMsg.content,
      created_at: assistantMsg.created_at,
    },
    balance,
    cost: model.free ? 0 : customerCharge,
    usage,
  };
}

// ─── Wallet deduction ─────────────────────────────────────────────────────────

async function deductFromWallet(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<number> {
  let wallet = await getWallet(db, userId);
  if (!wallet) wallet = await createWallet(db, userId);

  const toDeduct = Math.min(amount, wallet.balance);
  const newBalance = await updateWalletBalance(db, userId, -toDeduct);
  return newBalance;
}

// ─── Charge settlement (used by Stripe webhook) ───────────────────────────────

export async function creditWallet(
  db: D1Database,
  userId: string,
  amount: number,
): Promise<number> {
  let wallet = await getWallet(db, userId);
  if (!wallet) wallet = await createWallet(db, userId);
  return updateWalletBalance(db, userId, amount);
}
