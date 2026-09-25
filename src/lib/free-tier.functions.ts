import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Free allowance for the signed-in user. Read-only; limits are enforced server-side. */
export const fetchFreeUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getFreeUsageStatus } = await import("./free-tier.server");
    const { enforceRateLimit, RateLimitError } = await import("./rate-limit.server");

    try {
      await enforceRateLimit(context.userId, "read");
    } catch (error) {
      if (error instanceof RateLimitError) throw new Error(error.message);
      throw error;
    }

    return getFreeUsageStatus(context.userId);
  });
