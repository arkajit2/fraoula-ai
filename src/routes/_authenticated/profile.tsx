import { createFileRoute } from "@tanstack/react-router";
import { useProfile, useSession, useWallet } from "@/hooks/use-account";
import { formatUsd } from "@/lib/pricing";

export const Route = createFileRoute("/_authenticated/profile")({
  head: () => ({
    meta: [
      { title: "Profile · Fraoula AI" },
      { name: "description", content: "Your Fraoula AI account details." },
      { property: "og:title", content: "Profile · Fraoula AI" },
      { property: "og:description", content: "Your Fraoula AI account details." },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const { user } = useSession();
  const { data: profile } = useProfile(user?.id);
  const { data: wallet } = useWallet(user?.id);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[850px] px-4 py-10 sm:px-6">
        <h1 className="font-display text-2xl tracking-tight">Profile</h1>

        <div className="mt-6 flex items-center gap-4 rounded-2xl border p-5">
          {profile?.avatar_url ? (
            <img src={profile.avatar_url} alt="" className="h-14 w-14 rounded-full object-cover" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-lg font-medium">
              {(profile?.name ?? profile?.email ?? "?").slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <p className="font-medium">{profile?.name ?? "-"}</p>
            <p className="text-sm text-muted-foreground">{profile?.email}</p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border p-5">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Credit balance</p>
          <p className="mt-1 font-display text-xl">{formatUsd(Number(wallet?.balance ?? 0))}</p>
        </div>
      </div>
    </div>
  );
}
