import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Users, UserPlus, Calendar } from "lucide-react";
import { getAdminStats } from "@/lib/admin.functions";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Admin · Fraoula AI" },
      { name: "description", content: "User sign-up and subscription overview." },
      { property: "og:title", content: "Admin · Fraoula AI" },
      { property: "og:description", content: "User sign-up and subscription overview." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminPage,
});

function AdminPage() {
  const fetchStats = useServerFn(getAdminStats);
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => fetchStats(),
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1100px] px-4 py-10 sm:px-6">
        <h1 className="font-display text-2xl tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">User sign-up and subscription overview.</p>

        {error ? (
          <div className="mt-10 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-8 text-center">
            <p className="text-sm font-medium text-destructive">
              {error instanceof Error && "statusCode" in error && error.statusCode === 403
                ? "You don't have permission to view this page."
                : "Couldn't load admin data."}
            </p>
          </div>
        ) : isLoading ? (
          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard icon={Users} label="Total users" value={data?.total ?? 0} />
              <StatCard icon={UserPlus} label="Last 7 days" value={data?.last7 ?? 0} />
              <StatCard icon={Calendar} label="Last 30 days" value={data?.last30 ?? 0} />
            </div>

            <p className="mt-8 text-sm text-muted-foreground">
              Last 90 days: <strong className="text-foreground">{data?.last90 ?? 0}</strong>
            </p>

            <div className="mt-6 overflow-x-auto rounded-xl border">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-muted/60">
                  <tr>
                    {["User", "Email", "Signed up", "Plan"].map((h) => (
                      <th key={h} className="border-b px-3 py-2.5 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.users.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                        No users yet.
                      </td>
                    </tr>
                  ) : (
                    data?.users.map((user) => (
                      <tr key={user.id}>
                        <td className="border-b px-3 py-2.5">
                          <span className="font-medium">{user.name ?? "—"}</span>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{user.id.slice(0, 8)}</span>
                        </td>
                        <td className="border-b px-3 py-2.5 text-muted-foreground">{user.email ?? "—"}</td>
                        <td className="border-b px-3 py-2.5 text-muted-foreground">
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                        <td className="border-b px-3 py-2.5">
                          {user.plan_id ? (
                            <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                              {user.plan_id}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Free</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
