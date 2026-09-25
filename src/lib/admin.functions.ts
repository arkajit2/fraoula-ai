import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface AdminUser {
  id: string;
  name: string | null;
  email: string | null;
  created_at: string;
  plan_id: string | null;
  subscription_status: string | null;
}

export interface AdminStats {
  total: number;
  last7: number;
  last30: number;
  last90: number;
  users: AdminUser[];
}

export const getAdminStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (!isAdmin) {
      const err = new Error("Forbidden") as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Source of truth is auth users (covers Google sign-ups that never got a profile row).
    const authUsers: { id: string; email: string | null; created_at: string; name: string | null }[] = [];
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      for (const u of data.users) {
        authUsers.push({
          id: u.id,
          email: u.email ?? null,
          created_at: u.created_at,
          name:
            (u.user_metadata?.["full_name"] as string | undefined) ??
            (u.user_metadata?.["name"] as string | undefined) ??
            null,
        });
      }
      if (data.users.length < 200) break;
    }

    const [{ data: profiles }, { data: subscriptions }] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, name, email"),
      supabaseAdmin
        .from("subscriptions")
        .select("user_id, plan_id, status")
        .in("status", ["active", "trialing", "past_due"])
        .or("current_period_end.is.null,current_period_end.gt.now()"),
    ]);

    const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
    const planByUser = new Map<string, { plan_id: string; status: string }>();
    for (const sub of subscriptions ?? []) {
      if (!planByUser.has(sub.user_id)) {
        planByUser.set(sub.user_id, { plan_id: sub.plan_id, status: sub.status });
      }
    }

    const users: AdminUser[] = authUsers
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((u) => {
        const p = profileById.get(u.id);
        const sub = planByUser.get(u.id);
        return {
          id: u.id,
          name: p?.name ?? u.name,
          email: p?.email ?? u.email,
          created_at: u.created_at,
          plan_id: sub?.plan_id ?? null,
          subscription_status: sub?.status ?? null,
        };
      });

    const since = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000;
    const countSince = (days: number) =>
      users.filter((u) => new Date(u.created_at).getTime() > since(days)).length;

    return {
      total: users.length,
      last7: countSince(7),
      last30: countSince(30),
      last90: countSince(90),
      users,
    } satisfies AdminStats;
  });

