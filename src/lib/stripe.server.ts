import Stripe from "stripe";
import { getCreditPackageByPriceId, getPlanByPriceId } from "./pricing";
import {
  getWallet,
  createWallet,
  updateWalletBalance,
  recordTransaction,
  upsertSubscription,
} from "./db.server";

export type StripeEnv = "sandbox" | "live";

function getEnv(key: string): string {
  const globalEnv = (globalThis as any).__env__;
  const val = globalEnv?.[key] || (typeof process !== "undefined" ? process.env?.[key] : undefined);
  return val || "";
}

export function getStripeKey(): string {
  return (
    getEnv("STRIPE_SECRET_KEY") ||
    getEnv("STRIPE_API_KEY") ||
    getEnv("STRIPE_LIVE_API_KEY") ||
    getEnv("STRIPE_SANDBOX_API_KEY") ||
    ""
  );
}

export function getWebhookSecret(): string {
  return (
    getEnv("STRIPE_WEBHOOK_SECRET") ||
    getEnv("stripe_webhook_key") ||
    getEnv("PAYMENTS_LIVE_WEBHOOK_SECRET") ||
    getEnv("PAYMENTS_SANDBOX_WEBHOOK_SECRET") ||
    ""
  );
}

/** Pure Cloudflare Workers direct Stripe client (no Lovable proxy dependency). */
export function createStripeClient(apiKey?: string): Stripe {
  const key = apiKey || getStripeKey();
  return new Stripe(key, {
    apiVersion: "2023-10-16" as any,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getStripeErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stripeError = error as { message?: string; raw?: { message?: string } };
    return stripeError.raw?.message ?? stripeError.message ?? "Stripe request failed";
  }
  return "Stripe request failed";
}

/**
 * Webhook signature verifier using Web Crypto (HMAC-SHA256).
 */
export async function verifyWebhook(
  req: Request,
  secretOverride?: string,
): Promise<{ type: string; data: { object: any } }> {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  const secret = secretOverride || getWebhookSecret();

  if (!signature || !body) throw new Error("Missing signature or body");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");

  let timestamp: string | undefined;
  const v1Signatures: string[] = [];
  for (const part of signature.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value?.trim();
    if (key === "v1") v1Signatures.push(value?.trim());
  }

  if (!timestamp || v1Signatures.length === 0) throw new Error("Invalid signature format");

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 600) throw new Error("Webhook timestamp too old");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );

  const hashArray = Array.from(new Uint8Array(signed));
  const expected = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  if (!v1Signatures.includes(expected)) {
    throw new Error("Invalid webhook signature");
  }

  return JSON.parse(body);
}

/**
 * Main Webhook Event Processor for D1.
 * Supports credit package fulfillment, subscriptions, and renewal invoices.
 */
export async function processStripeWebhook(
  event: { type: string; data: { object: any } },
  db?: D1Database,
): Promise<{ success: boolean; handled: string }> {
  const targetDb = db || (globalThis as any).__env__?.DB || (process.env as any)?.DB;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const credits = Number(session.metadata?.credits || 0);
      const packageId = session.metadata?.packageId;

      if (userId && targetDb) {
        if (credits > 0) {
          let wallet = await getWallet(targetDb, userId);
          if (!wallet) wallet = await createWallet(targetDb, userId);
          await updateWalletBalance(targetDb, userId, credits);

          await recordTransaction(targetDb, {
            user_id: userId,
            amount: Number(session.amount_total || 0) / 100,
            type: "credit",
            description: `Purchased credit package (${packageId || "standard"})`,
            stripe_payment_intent_id: session.payment_intent || session.id,
            status: "completed",
          });
        }
      }
      return { success: true, handled: event.type };
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (userId && targetDb) {
        const item = sub.items?.data?.[0];
        const priceId = item?.price?.id || item?.price?.lookup_key || "";
        const plan = getPlanByPriceId(priceId);

        await upsertSubscription(targetDb, {
          user_id: userId,
          plan_id: plan?.id || "plus",
          stripe_subscription_id: sub.id,
          stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
          price_id: priceId,
          status: sub.status || "active",
          cancel_at_period_end: sub.cancel_at_period_end ? 1 : 0,
          current_period_start: sub.current_period_start
            ? new Date(sub.current_period_start * 1000).toISOString()
            : undefined,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : undefined,
        });
      }
      return { success: true, handled: event.type };
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id;

      if (subscriptionId && targetDb) {
        const line = invoice.lines?.data?.[0];
        const priceId = line?.price?.id || line?.price?.lookup_key || "";
        const plan = getPlanByPriceId(priceId);

        if (plan) {
          const userId = invoice.subscription_details?.metadata?.userId;
          if (userId) {
            let wallet = await getWallet(targetDb, userId);
            if (!wallet) wallet = await createWallet(targetDb, userId);
            await updateWalletBalance(targetDb, userId, plan.monthlyCredits);

            await recordTransaction(targetDb, {
              user_id: userId,
              amount: Number(invoice.amount_paid || 0) / 100,
              type: "credit",
              description: `${plan.name} monthly subscription credits`,
              stripe_payment_intent_id: invoice.payment_intent || invoice.id,
              status: "completed",
            });
          }
        }
      }
      return { success: true, handled: event.type };
    }

    default:
      return { success: true, handled: `ignored: ${event.type}` };
  }
}
