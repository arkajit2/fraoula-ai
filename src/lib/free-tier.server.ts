/**
 * SERVER-ONLY free-tier engine.
 *
 * All free-model limits are enforced here — the client never decides whether a
 * request is allowed. Limits are loaded from the `app_settings` table
 * (`free_tier_limits`) so an administrator can change them without a redeploy,
 * falling back to FREE_TIER_DEFAULTS.
 *
 * The allowance check and its counters are advanced by a single atomic database
 * function, so concurrent tabs or retries can never exceed the limit.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  FREE_LIMIT_MESSAGE,
  FREE_TIER_DEFAULTS,
  RATE_LIMIT_MESSAGE,
  type FreeTierLimits,
} from "./pricing";

export class FreeTierError extends Error {}

export async function loadFreeTierLimits(): Promise<FreeTierLimits> {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "free_tier_limits")
    .maybeSingle();

  const stored = (data?.value ?? {}) as Partial<FreeTierLimits>;
  const merged = { ...FREE_TIER_DEFAULTS, ...stored };

  // Configuration is untrusted input too: coerce to sane positive integers.
  const clamp = (value: unknown, fallback: number) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;

  return {
    maxMessagesPer24h: clamp(merged.maxMessagesPer24h, FREE_TIER_DEFAULTS.maxMessagesPer24h),
    maxRequestsPerMinute: clamp(merged.maxRequestsPerMinute, FREE_TIER_DEFAULTS.maxRequestsPerMinute),
    maxInputTokensPerDay: clamp(merged.maxInputTokensPerDay, FREE_TIER_DEFAULTS.maxInputTokensPerDay),
    maxOutputTokensPerDay: clamp(merged.maxOutputTokensPerDay, FREE_TIER_DEFAULTS.maxOutputTokensPerDay),
  };
}

export interface FreeUsageStatus {
  limits: FreeTierLimits;
  messagesUsed: number;
  inputTokensUsed: number;
  outputTokensUsed: number;
  resetAt: string;
  exhausted: boolean;
  reason: string | null;
}

/** Read-only snapshot for the UI. Never used to authorise a request. */
export async function getFreeUsageStatus(userId: string): Promise<FreeUsageStatus> {
  const limits = await loadFreeTierLimits();
  const { data } = await supabaseAdmin
    .from("daily_free_usage")
    .select("messages_used, input_tokens_used, output_tokens_used, reset_at")
    .eq("user_id", userId)
    .maybeSingle();

  const expired = data ? new Date(data.reset_at).getTime() <= Date.now() : true;
  const messagesUsed = expired ? 0 : data!.messages_used;
  const inputTokensUsed = expired ? 0 : data!.input_tokens_used;
  const outputTokensUsed = expired ? 0 : data!.output_tokens_used;

  const exhausted =
    messagesUsed >= limits.maxMessagesPer24h ||
    inputTokensUsed >= limits.maxInputTokensPerDay ||
    outputTokensUsed >= limits.maxOutputTokensPerDay;

  return {
    limits,
    messagesUsed,
    inputTokensUsed,
    outputTokensUsed,
    resetAt: data && !expired ? data.reset_at : new Date(Date.now() + 86_400_000).toISOString(),
    exhausted,
    reason: exhausted ? FREE_LIMIT_MESSAGE : null,
  };
}

/**
 * Atomically verifies and reserves free-tier headroom. Throws when any limit is
 * already reached — whichever is hit first wins.
 */
export async function assertFreeAllowance(userId: string): Promise<void> {
  const limits = await loadFreeTierLimits();
  const { data, error } = await supabaseAdmin.rpc("consume_free_allowance", {
    _user_id: userId,
    _max_messages: limits.maxMessagesPer24h,
    _max_rpm: limits.maxRequestsPerMinute,
    _max_input: limits.maxInputTokensPerDay,
    _max_output: limits.maxOutputTokensPerDay,
  });

  if (error) throw new FreeTierError("Free usage is temporarily unavailable. Please try again.");
  if (data === "FREE_LIMIT") throw new FreeTierError(FREE_LIMIT_MESSAGE);
  if (data === "RATE_LIMIT") throw new FreeTierError(RATE_LIMIT_MESSAGE);
}

/** Records a completed free request against the daily counters. */
export async function recordFreeUsage(
  userId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  await supabaseAdmin.rpc("record_free_usage", {
    _user_id: userId,
    _input_tokens: inputTokens,
    _output_tokens: outputTokens,
  });
}
