import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/use-account";

export const Route = createFileRoute("/_authenticated/usage")({
  head: () => ({
    meta: [
      { title: "Usage · Fraoula AI" },
      { name: "description", content: "Token usage per AI request." },
      { property: "og:title", content: "Usage · Fraoula AI" },
      { property: "og:description", content: "Token usage per AI request." },
    ],
  }),
  component: UsagePage,
});

function UsagePage() {
  const { user } = useSession();
  const { data = [] } = useQuery({
    queryKey: ["usage", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("usage")
        .select(
          "id, created_at, provider, model, input_tokens, output_tokens, cached_input_tokens, cache_write_tokens, cache_read_tokens, conversation_id",
        )
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[850px] px-4 py-10 sm:px-6">
        <h1 className="font-display text-2xl tracking-tight">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every request, newest first.</p>

        {data.length === 0 ? (
          <p className="mt-10 text-sm text-muted-foreground">No usage yet.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-muted/60">
                <tr>
                  {["Date", "Model", "Provider", "Input", "Output", "Cached in", "Cache w/r"].map(
                    (h) => (
                      <th key={h} className="border-b px-3 py-2.5 text-left font-medium">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id}>
                    <td className="border-b px-3 py-2.5 text-muted-foreground">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="border-b px-3 py-2.5">{row.model}</td>
                    <td className="border-b px-3 py-2.5 text-muted-foreground">{row.provider}</td>
                    <td className="border-b px-3 py-2.5">{row.input_tokens.toLocaleString()}</td>
                    <td className="border-b px-3 py-2.5">{row.output_tokens.toLocaleString()}</td>
                    <td className="border-b px-3 py-2.5">{row.cached_input_tokens.toLocaleString()}</td>
                    <td className="border-b px-3 py-2.5 text-muted-foreground">
                      {row.cache_write_tokens.toLocaleString()} / {row.cache_read_tokens.toLocaleString()}
                    </td>
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
