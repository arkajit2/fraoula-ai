import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getCreditPackageByPriceId, getPlanByPriceId } from "@/lib/pricing";
import {
  type StripeEnv,
  createStripeClient,
  getStripeErrorMessage,
} from "@/lib/stripe.server";
import type Stripe from "stripe";

type CheckoutSessionResult = { clientSecret: string } | { error: string };

/**
 * Resolves the Stripe customer for this user, keyed on `metadata.userId` so
 * later lookups (receipts, support, refunds) can always find them.
 */
async function resolveOrCreateCustomer(
  stripe: ReturnType<typeof createStripeClient>,
  options: { email?: string; userId: string },
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(options.userId)) throw new Error("Invalid userId");

  const found = await stripe.customers.search({
    query: `metadata['userId']:'${options.userId}'`,
    limit: 1,
  });
  if (found.data.length) return found.data[0].id;

  if (options.email) {
    const existing = await stripe.customers.list({ email: options.email, limit: 1 });
    if (existing.data.length) {
      const customer = existing.data[0];
      if (customer.metadata?.userId !== options.userId) {
        await stripe.customers.update(customer.id, {
          metadata: { ...customer.metadata, userId: options.userId },
        });
      }
      return customer.id;
    }
  }

  const created = await stripe.customers.create({
    ...(options.email && { email: options.email }),
    metadata: { userId: options.userId },
  });
  return created.id;
}

/**
 * Creates an embedded checkout session for a credit package.
 *
 * The caller only chooses *which* package — the amount, the credits granted and
 * the user it belongs to are all resolved server-side, so a tampered request
 * can't buy $100 of credits for $1 or credit somebody else's wallet.
 */
export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { priceId: string; returnUrl: string; environment: StripeEnv }) => {
    if (!getCreditPackageByPriceId(data.priceId)) throw new Error("Unknown credit package");
    if (data.environment !== "sandbox" && data.environment !== "live") {
      throw new Error("Invalid environment");
    }
    if (!/^https?:\/\//.test(data.returnUrl)) throw new Error("Invalid return URL");
    return data;
  })
  .handler(async ({ data, context }): Promise<CheckoutSessionResult> => {
    const pkg = getCreditPackageByPriceId(data.priceId)!;

    try {
      const stripe = createStripeClient(data.environment);

      const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
      if (!prices.data.length) throw new Error("Price not found");
      const stripePrice = prices.data[0];

      const {
        data: { user },
      } = await context.supabase.auth.getUser();

      const customerId = await resolveOrCreateCustomer(stripe, {
        email: user?.email ?? undefined,
        userId: context.userId,
      });

      const params = {
        line_items: [{ price: stripePrice.id, quantity: 1 }],
        mode: "payment",
        ui_mode: "embedded_page",
        return_url: data.returnUrl,
        customer: customerId,
        payment_intent_data: { description: `${pkg.name} credits` },
        // Credits are granted from this metadata by the webhook — never from
        // anything the browser sends back after checkout.
        metadata: {
          userId: context.userId,
          packageId: pkg.id,
          credits: String(pkg.credits),
        },
        managed_payments: { enabled: true },
      } as Stripe.Checkout.SessionCreateParams;

      let session;
      try {
        session = await stripe.checkout.sessions.create(params);
      } catch {
        // Full compliance handling isn't available for every seller country;
        // fall back to tax calculation and collection so checkout still works.
        const { managed_payments: _omit, ...rest } = params as Record<string, unknown>;
        session = await stripe.checkout.sessions.create({
          ...(rest as Stripe.Checkout.SessionCreateParams),
          automatic_tax: { enabled: true },
        });
      }

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/* ------------------------------------------------------------------------- *
 * Subscriptions
 * ------------------------------------------------------------------------- */

type PortalResult = { url: string } | { error: string };
type PlanChangeResult = { ok: true } | { error: string };

/** The caller's current subscription, as the billing page needs to render it. */
export const fetchSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { environment: StripeEnv }) => {
    if (data.environment !== "sandbox" && data.environment !== "live") {
      throw new Error("Invalid environment");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: row } = await context.supabase
      .from("subscriptions")
      .select("plan_id, price_id, status, current_period_end, cancel_at_period_end")
      .eq("environment", data.environment)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row) return null;
    const live =
      ["active", "trialing", "past_due"].includes(row.status) ||
      (row.status === "canceled" &&
        !!row.current_period_end &&
        new Date(row.current_period_end) > new Date());
    return live ? row : null;
  });

/**
 * Starts an embedded checkout for a monthly plan. The plan is resolved from the
 * server-side catalogue, so the price can't be swapped by the browser.
 */
export const createSubscriptionCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { priceId: string; returnUrl: string; environment: StripeEnv }) => {
    if (!getPlanByPriceId(data.priceId)) throw new Error("Unknown plan");
    if (data.environment !== "sandbox" && data.environment !== "live") {
      throw new Error("Invalid environment");
    }
    if (!/^https?:\/\//.test(data.returnUrl)) throw new Error("Invalid return URL");
    return data;
  })
  .handler(async ({ data, context }): Promise<CheckoutSessionResult> => {
    const plan = getPlanByPriceId(data.priceId)!;

    try {
      const stripe = createStripeClient(data.environment);

      const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
      if (!prices.data.length) throw new Error("Plan price not found");

      const {
        data: { user },
      } = await context.supabase.auth.getUser();

      const customerId = await resolveOrCreateCustomer(stripe, {
        email: user?.email ?? undefined,
        userId: context.userId,
      });

      const params = {
        line_items: [{ price: prices.data[0].id, quantity: 1 }],
        mode: "subscription",
        ui_mode: "embedded_page",
        return_url: data.returnUrl,
        customer: customerId,
        metadata: { userId: context.userId, planId: plan.id },
        // Mirrored onto the subscription so every renewal webhook knows who to
        // credit, even years after the original checkout.
        subscription_data: { metadata: { userId: context.userId, planId: plan.id } },
        managed_payments: { enabled: true },
      } as Stripe.Checkout.SessionCreateParams;

      let session;
      try {
        session = await stripe.checkout.sessions.create(params);
      } catch {
        const { managed_payments: _omit, ...rest } = params as Record<string, unknown>;
        session = await stripe.checkout.sessions.create({
          ...(rest as Stripe.Checkout.SessionCreateParams),
          automatic_tax: { enabled: true },
        });
      }

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/**
 * Switches an existing subscription to another plan immediately, with Stripe
 * prorating the difference. Upgrades take effect at once; downgrades credit the
 * unused time back against the next invoice.
 */
export const changeSubscriptionPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { priceId: string; environment: StripeEnv }) => {
    if (!getPlanByPriceId(data.priceId)) throw new Error("Unknown plan");
    if (data.environment !== "sandbox" && data.environment !== "live") {
      throw new Error("Invalid environment");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<PlanChangeResult> => {
    const plan = getPlanByPriceId(data.priceId)!;

    const { data: row } = await context.supabase
      .from("subscriptions")
      .select("stripe_subscription_id, plan_id, status")
      .eq("environment", data.environment)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row || row.status === "canceled") return { error: "No active subscription to change." };
    if (row.plan_id === plan.id) return { error: "You're already on that plan." };

    try {
      const stripe = createStripeClient(data.environment);
      const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
      if (!prices.data.length) throw new Error("Plan price not found");

      const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      const item = subscription.items.data[0];

      await stripe.subscriptions.update(row.stripe_subscription_id, {
        items: [{ id: item.id, price: prices.data[0].id }],
        proration_behavior: "always_invoice",
        cancel_at_period_end: false,
        metadata: { ...subscription.metadata, planId: plan.id },
      });

      return { ok: true };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/** Opens Stripe's billing portal for cancellations, cards and invoices. */
export const createPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { returnUrl: string; environment: StripeEnv }) => {
    if (data.environment !== "sandbox" && data.environment !== "live") {
      throw new Error("Invalid environment");
    }
    if (!/^https?:\/\//.test(data.returnUrl)) throw new Error("Invalid return URL");
    return data;
  })
  .handler(async ({ data, context }): Promise<PortalResult> => {
    const { data: row } = await context.supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("environment", data.environment)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!row?.stripe_customer_id) return { error: "No subscription found." };

    try {
      const stripe = createStripeClient(data.environment);
      const portal = await stripe.billingPortal.sessions.create({
        customer: row.stripe_customer_id,
        return_url: data.returnUrl,
      });
      return { url: portal.url };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });
