import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/use-account";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authenticated/security")({
  head: () => ({
    meta: [
      { title: "Security · Fraoula AI" },
      { name: "description", content: "Turn on optional two-factor authentication for your Fraoula AI account." },
      { property: "og:title", content: "Security · Fraoula AI" },
      {
        property: "og:description",
        content: "Turn on optional two-factor authentication for your Fraoula AI account.",
      },
    ],
  }),
  component: SecurityPage,
});

type Factor = { id: string; friendly_name?: string | null; status: string };

function SecurityPage() {
  const { user } = useSession();

  const [emailTwoFactor, setEmailTwoFactor] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);

  const [factors, setFactors] = useState<Factor[]>([]);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const loadFactors = async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.totp ?? []) as Factor[]);
  };

  useEffect(() => {
    void loadFactors();
  }, []);

  useEffect(() => {
    if (!user?.id) return;
    void supabase
      .from("profiles")
      .select("email_2fa_enabled")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => setEmailTwoFactor(Boolean((data as { email_2fa_enabled?: boolean } | null)?.email_2fa_enabled)));
  }, [user?.id]);

  const toggleEmail = async (next: boolean) => {
    if (!user?.id) return;
    setEmailTwoFactor(next);
    setSavingEmail(true);
    const { error } = await supabase
      .from("profiles")
      .update({ email_2fa_enabled: next } as never)
      .eq("id", user.id);
    setSavingEmail(false);
    if (error) {
      setEmailTwoFactor(!next);
      toast.error("Couldn't update that setting. Please try again.");
      return;
    }
    toast.success(next ? "Email 2FA is on." : "Email 2FA is off.");
  };

  const startEnroll = async () => {
    setBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
    });
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Couldn't start setup.");
      return;
    }
    setCode("");
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const confirmEnroll = async () => {
    if (!enroll) return;
    setBusy(true);
    const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({ factorId: enroll.id });
    if (cErr || !challenge) {
      setBusy(false);
      toast.error(cErr?.message ?? "Couldn't verify that code.");
      return;
    }
    const { error } = await supabase.auth.mfa.verify({
      factorId: enroll.id,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setBusy(false);
    if (error) {
      toast.error("That code didn't match. Try the next one.");
      return;
    }
    setEnroll(null);
    setCode("");
    await loadFactors();
    toast.success("Authenticator app enabled.");
  };

  const cancelEnroll = async () => {
    if (enroll) await supabase.auth.mfa.unenroll({ factorId: enroll.id });
    setEnroll(null);
    setCode("");
    await loadFactors();
  };

  const removeFactor = async (factorId: string) => {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) {
      toast.error(error.message);
      return;
    }
    await loadFactors();
    toast.success("Authenticator app removed.");
  };

  const verified = factors.filter((f) => f.status === "verified");

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[850px] px-4 py-10 sm:px-6">
        <h1 className="font-display text-2xl tracking-tight">Security</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two-factor authentication is optional. Turn on either method — or both — for extra protection.
        </p>

        <section className="mt-6 rounded-2xl border p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-medium">Email verification code</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    We'll email a one-time code to {user?.email} every time you sign in with a password.
                  </p>
                </div>
                <Switch checked={emailTwoFactor} disabled={savingEmail} onCheckedChange={toggleEmail} />
              </div>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-2xl border p-5">
          <div className="flex items-start gap-3">
            <Smartphone className="mt-0.5 h-5 w-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Authenticator app</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Use Google Authenticator, 1Password, Authy or any TOTP app.
              </p>

              {verified.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {verified.map((f) => (
                    <li key={f.id} className="flex items-center justify-between rounded-xl border px-3 py-2">
                      <span className="truncate text-sm">{f.friendly_name || "Authenticator app"}</span>
                      <button
                        type="button"
                        aria-label="Remove authenticator app"
                        onClick={() => void removeFactor(f.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {enroll ? (
                <div className="mt-4 space-y-3">
                  <img
                    src={enroll.qr}
                    alt="QR code for setting up your authenticator app"
                    className="h-44 w-44 rounded-xl border bg-background p-2"
                  />
                  <p className="text-xs text-muted-foreground">
                    Can't scan? Enter this key manually:{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{enroll.secret}</code>
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="totp-code">6-digit code</Label>
                    <Input
                      id="totp-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      className="max-w-[180px] tracking-[0.3em]"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy || code.trim().length < 6}
                      onClick={() => void confirmEnroll()}
                      className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? "Verifying…" : "Verify & enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void cancelEnroll()}
                      className="rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void startEnroll()}
                  className="mt-4 rounded-xl border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {verified.length > 0 ? "Add another app" : "Set up authenticator app"}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
