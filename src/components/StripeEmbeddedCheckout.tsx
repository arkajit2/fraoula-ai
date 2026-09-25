import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import { createCheckoutSession, createSubscriptionCheckout } from "@/lib/payments.functions";

export function StripeEmbeddedCheckout({
  priceId,
  returnUrl,
  mode = "credits",
}: {
  priceId: string;
  returnUrl?: string;
  /** "credits" buys a one-off pack, "plan" starts a monthly subscription. */
  mode?: "credits" | "plan";
}) {
  const fetchClientSecret = async (): Promise<string> => {
    const data = {
      priceId,
      returnUrl: returnUrl || window.location.href,
      environment: getStripeEnvironment(),
    };
    const result =
      mode === "plan"
        ? await createSubscriptionCheckout({ data })
        : await createCheckoutSession({ data });
    if ("error" in result) throw new Error(result.error);
    if (!result.clientSecret) throw new Error("Checkout could not be started.");
    return result.clientSecret;
  };

  return (
    <div id="checkout">
      <EmbeddedCheckoutProvider
        key={`${mode}:${priceId}`}
        stripe={getStripe()}
        options={{ fetchClientSecret }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
