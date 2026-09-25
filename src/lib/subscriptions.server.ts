import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { StripeEnv } from "./stripe.server";

/**
 * The plan a user is currently entitled to, or null for pay-as-you-go.
 *
 * A cancelled plan still counts until the paid period ends — that rule lives in
 * the `active_plan` database function so the browser can never influence it.
 * Live subscriptions win over sandbox ones so a test purchase can't upgrade a
 * real account, while preview testing still works when no live plan exists.
 */
export async function getActivePlanId(userId: string): Promise<string | null> {
  for (const environment of ["live", "sandbox"] as StripeEnv[]) {
    const { data } = await supabaseAdmin.rpc("active_plan", {
      _user_id: userId,
      _environment: environment,
    });
    if (data) return data as string;
  }
  return null;
}
