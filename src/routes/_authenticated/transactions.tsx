import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/use-account";

export const Route = createFileRoute("/_authenticated/transactions")({
  head: () => ({
    meta: [
      { title: "Transactions · Fraoula AI" },
      { name: "description", content: "Your credit purchases and payment history." },
      { property: "og:title", content: "Transactions · Fraoula AI" },
      { property: "og:description", content: "Your credit purchases and payment history." },
    ],
  }),
  component: TransactionsPage,
});

function TransactionsPage() {
  const { user } = useSession();
  const { data = [] } = useQuery({
    queryKey: ["transactions", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("id, created_at, package_name, amount_paid, credits_added, status, stripe_payment_id")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[850px] px-4 py-10 sm:px-6">
        <h1 className="font-display text-2xl tracking-tight">Transactions</h1>
        <p className="mt-1 text-sm text-muted-foreground">Credit purchases, newest first.</p>

        {data.length === 0 ? (
          <p className="mt-10 text-sm text-muted-foreground">No transactions yet.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/60">
                <tr>
                  {["Date", "Package", "Amount", "Credits", "Payment ID", "Status"].map((h) => (
                    <th key={h} className="border-b px-3 py-2.5 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <td className="border-b px-3 py-2.5 text-muted-foreground">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="border-b px-3 py-2.5">{row.package_name}</td>
                    <td className="border-b px-3 py-2.5">${Number(row.amount_paid).toFixed(2)}</td>
                    <td className="border-b px-3 py-2.5">${Number(row.credits_added).toFixed(2)}</td>
                    <td className="border-b px-3 py-2.5 font-mono text-xs text-muted-foreground">
                      {row.stripe_payment_id ?? "-"}
                    </td>
                    <td className="border-b px-3 py-2.5 capitalize">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
