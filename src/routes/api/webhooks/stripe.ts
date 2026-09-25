import { createFileRoute } from "@tanstack/react-router";
import { verifyWebhook, processStripeWebhook } from "@/lib/stripe.server";

export const Route = createFileRoute("/api/webhooks/stripe")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json({
          status: "active",
          service: "Fraoula AI Stripe Webhook Gateway",
          endpoint: "/api/webhooks/stripe",
        });
      },
      POST: async ({ request }) => {
        try {
          const event = await verifyWebhook(request);
          await processStripeWebhook(event);
          return Response.json({ received: true });
        } catch (error: any) {
          console.error("Stripe webhook verification failed:", error?.message);
          return new Response(
            JSON.stringify({ error: error?.message || "Invalid webhook signature" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});
