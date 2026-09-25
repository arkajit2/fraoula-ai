/**
 * SERVER-ONLY per-user rate limiting.
 *
 * Counters live in the database (`rate_limits`) and are advanced by a single
 * atomic function, so limits hold across concurrent tabs and across every
 * stateless worker instance. Buckets are configured centrally below.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface RateLimitRule {
  /** Maximum number of requests allowed inside the window. */
  limit: number;
  /** Rolling window length, in seconds. */
  windowSeconds: number;
}

/** Central rate-limit configuration — change limits here, never at call sites. */
export const RATE_LIMITS = {
  chat: { limit: 30, windowSeconds: 60 },
  chatBurst: { limit: 8, windowSeconds: 10 },
  read: { limit: 120, windowSeconds: 60 },
  payment: { limit: 10, windowSeconds: 60 },
  profile: { limit: 30, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

/** Thrown when a caller exceeds a bucket. Maps to HTTP 429 at the boundary. */
export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message = "Too many requests. Please slow down and try again shortly.") {
    super(message);
  }
}

/**
 * Consumes one unit from the bucket. Throws {@link RateLimitError} when the
 * caller is over the limit. Fails open only if the counter itself errors, so a
 * transient database blip never takes the whole app down.
 */
export async function enforceRateLimit(userId: string, bucket: RateLimitBucket): Promise<void> {
  const rule = RATE_LIMITS[bucket];
  const { data, error } = await supabaseAdmin.rpc("consume_rate_limit", {
    _user_id: userId,
    _bucket: bucket,
    _limit: rule.limit,
    _window_seconds: rule.windowSeconds,
  });

  if (error) return;
  if (data === false) throw new RateLimitError();
}
