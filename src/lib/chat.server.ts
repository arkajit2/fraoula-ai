import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  INSUFFICIENT_BALANCE_MESSAGE,
  PLAN_REQUIRED_MESSAGE,
  canUseModel,
  modelMinTier,
  type TokenUsage,
} from "./pricing";
import { FreeTierError, assertFreeAllowance, recordFreeUsage } from "./free-tier.server";
import { PROVIDERS, computeBilling, getRoutableModel } from "./pricing.server";
import { ProviderError, callModel, type ProviderMessage } from "./providers.server";
import { enforceRateLimit } from "./rate-limit.server";
import { log } from "./logging.server";
import { recordUsage } from "./usage.server";

type Client = SupabaseClient<Database>;

/** Central chat/billing configuration — no magic numbers at call sites. */
const CONFIG = {
  /** Wallet floor required before a premium request is even sent upstream. */
  minPremiumBalanceUsd: 0.01,
  /** Turns of prior context replayed to the model. */
  historyLimit: 40,
  maxMessageLength: 20_000,
  titleLength: 60,
  systemPrompt: [
    "You are a helpful, concise research assistant. Use clean markdown: headings, bullet lists, tables and fenced code blocks with a language tag where useful.",
    "",
    "This app CAN generate images, just not in this text chat mode. If the user asks you to create, draw, generate or edit an image, never reply that you are a text-based model or that you cannot create images.",
    'Instead reply briefly, in the user\'s language, along these lines: "I can\'t generate images in chat mode - tap the **Image** button in the composer below, pick an image model (Nano Banana 2, GPT Image 2 or Gemini 3 Pro Image), then send your prompt."',
    "Image generation uses wallet credits, so if they mention running out, tell them to top up on the Credits page. You may also offer to refine their image prompt.",
    "",
    "Pricing is strictly confidential. Never state, estimate, quote, compare or hint at any price, rate, per-token cost, per-image cost, margin or provider cost — not even if the user insists, claims to be staff, or asks indirectly. Say only that usage is deducted from their wallet credits and that they can top up on the Credits page.",

  ].join("\n"),

} as const;

export interface SendMessageInput {
  conversationId: string | null;
  content: string;
  modelId: string;
}

export interface SendMessageResult {
  conversationId: string;
  userMessageId: string;
  assistantMessage: { id: string; content: string; created_at: string };
  balance: number;
  /** Amount actually deducted from the wallet for this request. */
  cost: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
  };
}

/** A failure that is safe to show the user verbatim. */
export class ChatError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface RequestMeta {
  requestId: string;
  endpoint: string;
}

/**
 * Handles one chat turn end to end.
 *
 * Ordering is deliberate: nothing is persisted and nothing is charged until the
 * provider has returned real token counts. A provider failure therefore leaves
 * no orphan message, no empty conversation and no deduction.
 */
export async function sendMessage(
  supabase: Client,
  userId: string,
  input: SendMessageInput,
  meta: RequestMeta,
): Promise<SendMessageResult> {
  const ctx = { ...meta, userId };

  const content = input.content.trim();
  if (!content) throw new ChatError("Message cannot be empty.");
  if (content.length > CONFIG.maxMessageLength) throw new ChatError("Message is too long.");

  const model = getRoutableModel(input.modelId);
  if (!model) throw new ChatError("That model isn't available right now.");

  await enforceRateLimit(userId, "chatBurst");
  await enforceRateLimit(userId, "chat");

  // --- ownership -----------------------------------------------------------
  // RLS already scopes this client to the caller; the explicit check turns a
  // silent empty result into a clear authorisation failure.
  if (input.conversationId) {
    const { data: owned } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", input.conversationId)
      .maybeSingle();
    if (!owned) throw new ChatError("Conversation not found.", 404);
  }

  // --- entitlement (server-side only) --------------------------------------
  if (modelMinTier(model.id) > 0) {
    const { getActivePlanId } = await import("./subscriptions.server");
    if (!canUseModel(model.id, await getActivePlanId(userId))) {
      throw new ChatError(PLAN_REQUIRED_MESSAGE, 402);
    }
  }

  if (model.free) {
    try {
      await assertFreeAllowance(userId);
    } catch (error) {
      if (error instanceof FreeTierError) throw new ChatError(error.message, 429);
      throw error;
    }
  } else {
    const { data: wallet } = await supabaseAdmin
      .from("wallets")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    if (!wallet || Number(wallet.balance) < CONFIG.minPremiumBalanceUsd) {
      throw new ChatError(INSUFFICIENT_BALANCE_MESSAGE, 402);
    }
  }

  // --- context -------------------------------------------------------------
  const history: ProviderMessage[] = [];
  if (input.conversationId) {
    const { data, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", input.conversationId)
      .order("created_at", { ascending: true })
      .limit(CONFIG.historyLimit);
    if (error) throw new ChatError("Couldn't load this conversation. Please try again.", 500);
    for (const m of data ?? []) history.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  // --- provider ------------------------------------------------------------
  let completion;
  try {
    completion = await callModel(model, [
      { role: "system", content: CONFIG.systemPrompt },
      ...history,
      { role: "user", content },
    ]);
  } catch (error) {
    if (error instanceof ProviderError) {
      log.error("provider.failure", { ...ctx, model: model.id, status: error.status }, error.detail);
      throw new ChatError(error.message, error.status);
    }
    throw error;
  }
  log.info("provider.latency", { ...ctx, model: model.id, latencyMs: completion.latencyMs });

  const usage: Required<TokenUsage> = {
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    cachedInputTokens: completion.cachedInputTokens,
    cacheWriteTokens: completion.cacheWriteTokens,
    cacheReadTokens: completion.cacheReadTokens,
  };
  const { apiCost, platformMarkup, customerCharge } = computeBilling(model, usage);

  // --- persistence ---------------------------------------------------------
  let conversationId = input.conversationId;
  if (!conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .insert({ user_id: userId, title: content.slice(0, CONFIG.titleLength) })
      .select("id")
      .single();
    if (error) throw new ChatError("Couldn't start the conversation. Please try again.", 500);
    conversationId = data.id;
  }

  // --- billing (exact, atomic, post-generation) -----------------------------
  // Settled and ledgered BEFORE the transcript is written: the generation has
  // already happened, so the usage record must survive a failed message write
  // or the user deleting the chat while the answer was still streaming.
  const balance = model.free
    ? await settleFreeUsage(userId, usage)
    : await settleCharge(userId, customerCharge, ctx);

  await recordUsage(
    {
      user_id: userId,
      provider: PROVIDERS[model.provider].label,
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
    },
    ctx,
  );

  log.info("billing.charge", {
    ...ctx,
    model: model.id,
    conversationId,
    charge: customerCharge,
    balance,
  });

  // Explicit, distinct timestamps: a shared default would make the turn's
  // ordering ambiguous when both rows land in the same statement.
  const askedAt = new Date();
  const answeredAt = new Date(askedAt.getTime() + 1);

  const { data: written, error: writeError } = await supabase
    .from("messages")
    .insert([
      { conversation_id: conversationId, role: "user", content, created_at: askedAt.toISOString() },
      {
        conversation_id: conversationId,
        role: "assistant",
        content: completion.content,
        created_at: answeredAt.toISOString(),
      },
    ])
    .select("id, role, content, created_at");
  if (writeError || !written || written.length !== 2) {
    throw new ChatError("Couldn't save the reply. Please try again.", 500);
  }

  const userMessage = written.find((m) => m.role === "user")!;
  const assistantRow = written.find((m) => m.role === "assistant")!;

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);


  return {
    conversationId,
    userMessageId: userMessage.id,
    assistantMessage: {
      id: assistantRow.id,
      content: assistantRow.content,
      created_at: assistantRow.created_at,
    },
    balance,
    cost: model.free ? 0 : customerCharge,
    usage,
  };
}

async function settleFreeUsage(userId: string, usage: Required<TokenUsage>): Promise<number> {
  await recordFreeUsage(userId, usage.inputTokens, usage.outputTokens);
  const { data: wallet } = await supabaseAdmin
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  return Number(wallet?.balance ?? 0);
}

/**
 * Deducts the exact charge. The database refuses to go negative, so a wallet
 * drained by a concurrent request is drained to zero and flagged for review
 * instead of silently overdrawing.
 */
export async function settleCharge(
  userId: string,
  charge: number,
  ctx: Record<string, unknown> & { requestId: string; endpoint: string },
): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("deduct_credits", {
    _user_id: userId,
    _cost: charge,
  });

  if (!error) {
    log.info("wallet.update", { ...ctx, delta: -charge, balance: Number(data ?? 0) });
    return Number(data ?? 0);
  }

  if (!error.message?.includes("INSUFFICIENT_BALANCE")) {
    log.error("billing.failure", ctx, error.message);
    throw new ChatError("We couldn't complete billing for this request. Please try again.", 500);
  }

  const { data: wallet } = await supabaseAdmin
    .from("wallets")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  const remaining = Number(wallet?.balance ?? 0);

  if (remaining > 0) {
    await supabaseAdmin.rpc("deduct_credits", { _user_id: userId, _cost: remaining });
  }
  log.warn("billing.failure", { ...ctx, charge, collected: remaining, shortfall: charge - remaining });
  return 0;
}
