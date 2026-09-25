import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CREDIT_PACKAGES, PLANS, formatUsd, getPlan } from "@/lib/pricing";
import { useSession, useWallet } from "@/hooks/use-account";
import { useSubscription } from "@/hooks/use-subscription";
import { changeSubscriptionPlan, createPortalSession } from "@/lib/payments.functions";
import { getStripeEnvironment } from "@/lib/stripe";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { StripeEmbeddedCheckout } from "@/components/StripeEmbeddedCheckout";

export const Route = createFileRoute("/_authenticated/billing")({
  head: () => ({
    meta: [
      { title: "Plans & credits · Fraoula AI" },
      { name: "description", content: "Choose a monthly plan or top up your prepaid AI credits." },
      { property: "og:title", content: "Plans & credits · Fraoula AI" },
      {
        property: "og:description",
        content: "Choose a monthly plan or top up your prepaid AI credits.",
      },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { checkout?: string } => ({
    checkout: typeof search.checkout === "string" ? search.checkout : undefined,
  }),
  component: BillingPage,
});

function BillingPage() {
  const { user } = useSession();
  const { data: wallet } = useWallet(user?.id);
  const { data: subscription, plan: currentPlan } = useSubscription(user?.id);
  const { checkout } = Route.useSearch();
  const queryClient = useQueryClient();
  const [activePriceId, setActivePriceId] = useState<string | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<"credits" | "plan">("credits");
  const [busy, setBusy] = useState(false);

  // Credits and plan changes are applied by the payment webhook, which can land
  // a moment after the customer returns — so refresh for a few seconds.
  useEffect(() => {
    if (checkout !== "success") return;
    toast.success("Payment received — your account is updating.");
    setActivePriceId(null);
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["wallet", user?.id] });
      queryClient.invalidateQueries({ queryKey: ["subscription", user?.id] });
    };
    const stop = window.setInterval(refresh, 2000);
    const done = window.setTimeout(() => window.clearInterval(stop), 20000);
    return () => {
      window.clearInterval(stop);
      window.clearTimeout(done);
    };
  }, [checkout, queryClient, user?.id]);

  const openCheckout = (priceId: string, mode: "credits" | "plan") => {
    setCheckoutMode(mode);
    setActivePriceId(priceId);
  };

  const switchPlan = async (priceId: string) => {
    setBusy(true);
    try {
      const result = await changeSubscriptionPlan({
        data: { priceId, environment: getStripeEnvironment() },
      });
      if ("error" in result) throw new Error(result.error);
      toast.success("Plan updated — the difference is prorated automatically.");
      queryClient.invalidateQueries({ queryKey: ["subscription", user?.id] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't change the plan.");
    } finally {
      setBusy(false);
    }
  };

  const manageBilling = async () => {
    setBusy(true);
    try {
      const result = await createPortalSession({
        data: {
          returnUrl: `${window.location.origin}/billing`,
          environment: getStripeEnvironment(),
        },
      });
      if ("error" in result) throw new Error(result.error);
      window.open(result.url, "_blank", "noopener");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't open billing.");
    } finally {
      setBusy(false);
    }
  };

  const renewal = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString()
    : null;

  return (
    <div className="h-full overflow-y-auto">
      <PaymentTestModeBanner />
      <div className="mx-auto w-full max-w-[850px] px-4 py-10 sm:px-6">
        <h1 className="font-display text-2xl tracking-tight">Plans &amp; credits</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A plan adds credits to your wallet every month and unlocks premium models. Credits are
          deducted per request based on real token usage.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Stat label="Balance" value={formatUsd(Number(wallet?.balance ?? 0))} />
          <Stat
            label="Lifetime purchased"
            value={formatUsd(Number(wallet?.lifetime_purchased ?? 0))}
          />
          <Stat label="Lifetime used" value={formatUsd(Number(wallet?.lifetime_used ?? 0))} />
        </div>

        {subscription && (
          <div className="mt-6 rounded-2xl border p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  Current plan: {currentPlan.name}
                  {subscription.status === "past_due" && (
                    <span className="ml-2 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive-foreground">
                      Payment failed
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {subscription.cancel_at_period_end || subscription.status === "canceled"
                    ? `Cancelled — access continues until ${renewal ?? "the end of the period"}.`
                    : renewal
                      ? `Renews ${renewal} · ${formatUsd(currentPlan.monthlyCredits)} in credits each month`
                      : `${formatUsd(currentPlan.monthlyCredits)} in credits each month`}
                </p>
              </div>
              <button
                type="button"
                onClick={manageBilling}
                disabled={busy}
                className="rounded-xl border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                Manage or cancel
              </button>
            </div>
          </div>
        )}

        <h2 className="mt-10 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Monthly plans
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {PLANS.map((plan) => {
            const isCurrent = subscription?.plan_id === plan.id;
            const canSwitch = !!subscription && !isCurrent;
            return (
              <div key={plan.id} className="flex flex-col rounded-2xl border p-5">
                <p className="text-sm font-medium">{plan.name}</p>
                <p className="mt-2 font-display text-2xl">
                  {formatUsd(plan.price)}
                  <span className="text-sm text-muted-foreground">/mo</span>
                </p>
                <ul className="mt-3 flex-1 space-y-1 text-xs text-muted-foreground">
                  {plan.highlights.map((line) => (
                    <li key={line}>· {line}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={isCurrent || busy}
                  onClick={() =>
                    canSwitch ? switchPlan(plan.priceId) : openCheckout(plan.priceId, "plan")
                  }
                  className="mt-4 w-full rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {isCurrent
                    ? "Current plan"
                    : canSwitch
                      ? getPlan(subscription?.plan_id).tier < plan.tier
                        ? "Upgrade"
                        : "Downgrade"
                      : "Subscribe"}
                </button>
              </div>
            );
          })}
        </div>
        {subscription && (
          <p className="mt-2 text-xs text-muted-foreground">
            Switching plans takes effect immediately and the difference is prorated. Cancelling
            keeps your access until the end of the paid period.
          </p>
        )}

        <h2 className="mt-10 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          One-off credit packs
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CREDIT_PACKAGES.map((pkg) => (
            <div key={pkg.id} className="rounded-2xl border p-5">
              <p className="text-sm font-medium">{pkg.name}</p>
              <p className="mt-2 font-display text-2xl">{formatUsd(pkg.price)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatUsd(pkg.credits)} in credits
              </p>
              <button
                type="button"
                onClick={() => openCheckout(pkg.priceId, "credits")}
                className="mt-4 w-full rounded-xl border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                Buy credits
              </button>
            </div>
          ))}
        </div>

        {activePriceId && (
          <div className="mt-6 rounded-2xl border p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Checkout</p>
              <button
                type="button"
                onClick={() => setActivePriceId(null)}
                className="text-xs text-muted-foreground underline"
              >
                Cancel
              </button>
            </div>
            <StripeEmbeddedCheckout
              priceId={activePriceId}
              mode={checkoutMode}
              returnUrl={`${window.location.origin}/billing?checkout=success`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-xl">{value}</p>
    </div>
  );
}
