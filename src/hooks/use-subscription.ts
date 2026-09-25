import { useQuery } from "@tanstack/react-query";
import { fetchSubscription } from "@/lib/payments.functions";
import { getStripeEnvironment } from "@/lib/stripe";
import { getPlan } from "@/lib/pricing";

/**
 * The signed-in user's live subscription, scoped to the environment this build
 * points at so a test purchase never leaks into a real account.
 */
export function useSubscription(userId?: string) {
  const query = useQuery({
    queryKey: ["subscription", userId],
    enabled: !!userId,
    queryFn: () => fetchSubscription({ data: { environment: getStripeEnvironment() } }),
  });

  return { ...query, plan: getPlan(query.data?.plan_id) };
}
