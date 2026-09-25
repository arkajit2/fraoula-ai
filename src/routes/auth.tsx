import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import logoAsset from "@/assets/fraoula-logo.jpg.asset.json";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in · Fraoula AI" },
      { name: "description", content: "Sign in to Fraoula AI to start chatting with AI models." },
      { property: "og:title", content: "Sign in · Fraoula AI" },
      { property: "og:description", content: "Sign in to Fraoula AI to start chatting with AI models." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  // Optional second factor
  const [step, setStep] = useState<"credentials" | "totp" | "email-otp">("credentials");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<{ factorId: string; challengeId: string } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) return;
      navigate({ to: "/chat", replace: true });
    });
  }, [navigate]);

  /** Returns true when a second factor is required (and the UI moved to that step). */
  const startSecondFactor = async (userId: string, userEmail: string) => {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp?.find((f) => f.status === "verified");
      if (factor) {
        const { data: ch, error } = await supabase.auth.mfa.challenge({ factorId: factor.id });
        if (error || !ch) throw error ?? new Error("Couldn't start verification.");
        setChallenge({ factorId: factor.id, challengeId: ch.id });
        setCode("");
        setStep("totp");
        return true;
      }
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("email_2fa_enabled")
      .eq("id", userId)
      .maybeSingle();

    if ((profile as { email_2fa_enabled?: boolean } | null)?.email_2fa_enabled) {
      await supabase.auth.signOut();
      const { error } = await supabase.auth.signInWithOtp({
        email: userEmail,
        options: { shouldCreateUser: false },
      });
      if (error) throw error;
      setCode("");
      setStep("email-otp");
      toast.success("We emailed you a verification code.");
      return true;
    }

    return false;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success("If that email is registered, we've sent a reset link.");
        setMode("signin");
        return;
      }
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin, data: { name } },
        });
        if (error) throw error;
        if (!data.session) {
          toast.success("Check your email to confirm your account.");
          return;
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (data.user && (await startSecondFactor(data.user.id, data.user.email ?? email))) return;
      }
      navigate({ to: "/chat", replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (step === "totp") {
        if (!challenge) throw new Error("Verification expired. Please sign in again.");
        const { error } = await supabase.auth.mfa.verify({
          factorId: challenge.factorId,
          challengeId: challenge.challengeId,
          code: code.trim(),
        });
        if (error) throw new Error("That code didn't match. Try the next one.");
      } else {
        const { error } = await supabase.auth.verifyOtp({
          email,
          token: code.trim(),
          type: "email",
        });
        if (error) throw new Error("That code didn't match or has expired.");
      }
      navigate({ to: "/chat", replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const cancelVerify = async () => {
    await supabase.auth.signOut();
    setChallenge(null);
    setCode("");
    setPassword("");
    setStep("credentials");
  };

  const handleGoogle = async () => {
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      toast.error("Google sign-in failed. Please try again.");
      return;
    }
    if (result.redirected) return;
    navigate({ to: "/chat", replace: true });
  };

  if (step !== "credentials") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center text-center">
            <img src={logoAsset.url} alt="Fraoula AI logo" className="h-12 w-12 rounded-xl object-cover" />
            <h1 className="mt-4 font-display text-2xl tracking-tight">Two-factor verification</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {step === "totp"
                ? "Enter the 6-digit code from your authenticator app."
                : `Enter the code we emailed to ${email}.`}
            </p>
          </div>

          <form onSubmit={handleVerify} className="mt-8 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="tracking-[0.3em]"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading || code.trim().length < 6}
              className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Verify"}
            </button>
          </form>

          <p className="mt-5 text-center text-sm text-muted-foreground">
            <button
              type="button"
              className="font-medium text-foreground underline-offset-4 hover:underline"
              onClick={() => void cancelVerify()}
            >
              Back to sign in
            </button>
          </p>
        </div>
      </div>
    );
  }


  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <img src={logoAsset.url} alt="Fraoula AI logo" className="h-12 w-12 rounded-xl object-cover" />
          <h1 className="mt-4 font-display text-2xl tracking-tight">
            {mode === "signin" ? "Welcome back" : mode === "signup" ? "Create your account" : "Reset your password"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "forgot"
              ? "We'll email you a link to set a new password."
              : "Fast, focused AI answers."}
          </p>
        </div>

        {mode !== "forgot" && (
          <>
            <button
              type="button"
              onClick={handleGoogle}
              className="mt-8 flex w-full items-center justify-center gap-2 rounded-xl border bg-background px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted"
            >
              <GoogleIcon />
              Continue with Google
            </button>

            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "signup" && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {mode !== "forgot" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                {mode === "signin" && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-4 hover:underline"
                    onClick={() => setMode("forgot")}
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <Input
                id="password"
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading
              ? "Please wait…"
              : mode === "signin"
                ? "Sign in"
                : mode === "signup"
                  ? "Create account"
                  : "Send reset link"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-muted-foreground">
          {mode === "forgot" ? (
            <button
              type="button"
              className="font-medium text-foreground underline-offset-4 hover:underline"
              onClick={() => setMode("signin")}
            >
              Back to sign in
            </button>
          ) : (
            <>
              {mode === "signin" ? "New here?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              >
                {mode === "signin" ? "Create an account" : "Sign in"}
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.6Z" />
      <path fill="#34A853" d="M12 23c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3C3.7 20.5 7.5 23 12 23Z" />
      <path fill="#FBBC05" d="M5.6 13.7a6.6 6.6 0 0 1 0-4.2v-3H1.8a11 11 0 0 0 0 10l3.8-2.8Z" />
      <path fill="#EA4335" d="M12 5.4c1.7 0 3.2.6 4.4 1.7l3.3-3.3C17.7 1.9 15.1.9 12 .9 7.5.9 3.7 3.5 1.8 7.2l3.8 3c.9-2.8 3.4-4.8 6.4-4.8Z" />
    </svg>
  );
}
