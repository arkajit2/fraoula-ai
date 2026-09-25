import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getCreditPackageByPriceId, getPlanByPriceId } from "@/lib/pricing";
import { type StripeEnv, createStripeClient, verifyWebhook } from "@/lib/stripe.server";

let _supabase: ReturnType<typeof createClient<Database>> | null = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient<Database>(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _supabase;
}

/**
 * Grants credits for a completed checkout.
 *
 * The amount is derived from the package configuration, never from the payload,
 * and the database keys the grant on the payment id — so a redelivered or
 * duplicated event credits the wallet exactly once.
 */
async function fulfillSession(session: any, env: StripeEnv) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error("payments.webhook: session without userId", session.id);
    return;
  }

  const stripe = createStripeClient(env);
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["line_items.data.price"],
  });

  const price = (full as any).line_items?.data?.[0]?.price;
  const lookupKey: string | undefined = price?.lookup_key ?? price?.metadata?.lovable_external_id;
  const pkg = lookupKey ? getCreditPackageByPriceId(lookupKey) : undefined;
  if (!pkg) {
    console.error("payments.webhook: unknown package for session", session.id, lookupKey);
    return;
  }

  const { error } = await getSupabase().rpc("credit_wallet_for_payment", {
    _user_id: userId,
    _payment_id: session.id,
    _package_name: pkg.name,
    _amount_paid: pkg.price,
    _credits: pkg.credits,
  });
  if (error) throw new Error(`credit_wallet_for_payment failed: ${error.message}`);
}

/** Resolves the human-readable price id Lovable assigned to a Stripe price. */
function lookupKeyOf(price: any): string | undefined {
  return price?.lookup_key ?? price?.metadata?.lovable_external_id;
}

/**
 * Mirrors a Stripe subscription into our table. Every field the app gates on —
 * plan, status, period end, pending cancellation — comes from Stripe, so the
 * database can never drift into granting access nobody paid for.
 */
async function syncSubscription(subscription: any, env: StripeEnv) {
  const userId = subscription.metadata?.userId;
  const item = subscription.items?.data?.[0];
  const plan = getPlanByPriceId(lookupKeyOf(item?.price) ?? "");
  if (!userId || !plan) {
    console.error("payments.webhook: unmapped subscription", subscription.id);
    return;
  }

  const periodStart = item?.current_period_start ?? subscription.current_period_start;
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;

  const { error } = await getSupabase()
    .from("subscriptions")
    .upsert(
      {
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_customer_id:
          typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id,
        price_id: plan.priceId,
        plan_id: plan.id,
        status: subscription.status,
        current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null,
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        // Cancelling keeps access until the paid period ends; the row stays put
        // and simply stops qualifying once `current_period_end` passes.
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
        environment: env,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_subscription_id" },
    );
  if (error) throw new Error(`subscription sync failed: ${error.message}`);
}

/**
 * Deposits a plan's monthly credits after a paid invoice — the first one and
 * every renewal. Keyed on the invoice id, so a redelivered event tops the
 * wallet up exactly once.
 */
async function grantPlanCredits(invoice: any, env: StripeEnv) {
  const subscriptionId =
    typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;

  const plan = getPlanByPriceId(lookupKeyOf(invoice.lines?.data?.[0]?.price) ?? "");
  if (!plan) return;

  const stripe = createStripeClient(env);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = (subscription.metadata as Record<string, string> | undefined)?.userId;
  if (!userId) {
    console.error("payments.webhook: invoice without userId", invoice.id);
    return;
  }

  await syncSubscription(subscription, env);

  const { error } = await getSupabase().rpc("credit_wallet_for_payment", {
    _user_id: userId,
    _payment_id: invoice.id,
    _package_name: `${plan.name} plan credits`,
    _amount_paid: Number(invoice.amount_paid ?? 0) / 100,
    _credits: plan.monthlyCredits,
  });
  if (error) throw new Error(`plan credit grant failed: ${error.message}`);
}

async function handleWebhook(request: Request, env: StripeEnv) {
  const event = await verifyWebhook(request, env);

  switch (event.type) {
    case "checkout.session.completed": {
      // "unpaid" means a delayed method (SEPA, boleto…) hasn't settled yet.
      if (event.data.object.payment_status !== "unpaid") {
        await fulfillSession(event.data.object, env);
      }
      break;
    }
    case "checkout.session.async_payment_succeeded":
      await fulfillSession(event.data.object, env);
      break;
    case "checkout.session.async_payment_failed":
      console.warn("payments.webhook: delayed payment failed", event.data.object.id);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object, env);
      break;
    case "invoice.paid":
      await grantPlanCredits(event.data.object, env);
      break;
    default:
      break;
  }
}

export const Route = createFileRoute("/api/public/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const rawEnv = new URL(request.url).searchParams.get("env");
        if (rawEnv !== "sandbox" && rawEnv !== "live") {
          return Response.json({ received: true, ignored: "invalid env" });
        }
        try {
          await handleWebhook(request, rawEnv);
          return Response.json({ received: true });
        } catch (e) {
          console.error("payments.webhook error:", e);
          return new Response("Webhook error", { status: 400 });
        }
      },
    },
  },
});
