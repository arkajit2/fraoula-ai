import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CreditCard,
  LayoutDashboard,
  LogOut,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  ShieldCheck,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import logoAsset from "@/assets/fraoula-logo.jpg.asset.json";
import { supabase } from "@/integrations/supabase/client";
import {
  useConversations,
  useIsAdmin,
  useProfile,
  useSession,
  useWallet,
} from "@/hooks/use-account";
import { formatUsd } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile(user?.id);
  const { data: wallet } = useWallet(user?.id);
  const { data: conversations = [] } = useConversations(user?.id);
  const { data: isAdmin } = useIsAdmin(user?.id);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleSignOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setDeleting(true);
    const { error } = await supabase.from("conversations").delete().eq("id", id);
    setDeleting(false);
    setPendingDelete(null);

    if (error) {
      toast.error("Couldn't delete that chat. Please try again.");
      return;
    }

    queryClient.invalidateQueries({ queryKey: ["conversations", user?.id] });
    queryClient.removeQueries({ queryKey: ["messages", id] });
    toast.success("Chat deleted.");
    if (pathname.endsWith(id)) navigate({ to: "/chat", replace: true });
  };


  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center gap-2 px-4 py-4">
        <img src={logoAsset.url} alt="Fraoula AI logo" className="h-7 w-7 rounded-lg object-cover" />
        <span className="font-display text-lg tracking-tight">Fraoula AI</span>
      </div>

      <div className="px-3">
        <Link
          to="/chat"
          onClick={onNavigate}
          className="flex w-full items-center gap-2 rounded-xl border bg-background px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
        >
          <MessageSquarePlus className="h-4 w-4" />
          New Chat
        </Link>
      </div>

      <div className="mt-6 flex-1 overflow-y-auto px-3">
        <p className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Chats</p>
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => (
              <li key={c.id} className="group relative">
                <Link
                  to="/chat/$conversationId"
                  params={{ conversationId: c.id }}
                  onClick={onNavigate}
                  className={cn(
                    "block truncate rounded-lg py-2 pl-2 pr-9 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                    pathname.endsWith(c.id) && "bg-muted text-foreground",
                  )}
                >
                  {c.title}
                </Link>
                <button
                  type="button"
                  aria-label={`Delete chat: ${c.title}`}
                  onClick={() => setPendingDelete({ id: c.id, title: c.title })}
                  className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-3 border-t p-3">
        <Link
          to="/billing"
          onClick={onNavigate}
          className="block rounded-xl border bg-background px-3 py-2.5 transition-colors hover:bg-muted"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Credits</p>
          <p className="mt-0.5 text-sm font-medium">
            {formatUsd(Number(wallet?.balance ?? 0))} remaining
          </p>
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted">
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {(profile?.name ?? profile?.email ?? "?").slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{profile?.name ?? "Account"}</span>
              <span className="block truncate text-xs text-muted-foreground">{profile?.email}</span>
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56 rounded-xl">
            <DropdownMenuItem asChild>
              <Link to="/profile" onClick={onNavigate}>
                <UserIcon className="mr-2 h-4 w-4" /> Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/usage" onClick={onNavigate}>
                <Receipt className="mr-2 h-4 w-4" /> Usage
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/transactions" onClick={onNavigate}>
                <CreditCard className="mr-2 h-4 w-4" /> Transactions
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/security" onClick={onNavigate}>
                <ShieldCheck className="mr-2 h-4 w-4" /> Security
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link to="/admin" onClick={onNavigate}>
                  <LayoutDashboard className="mr-2 h-4 w-4" /> Admin
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handleSignOut}>
              <LogOut className="mr-2 h-4 w-4" /> Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.title}” and all of its messages will be permanently removed. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
    </button>
  );
}
