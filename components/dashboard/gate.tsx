"use client";

import { useState, type FormEvent } from "react";
import { useConvex } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { CommandLine, PerryMark, SecretInput } from "./common";

/** The locked door: one field, checked against the server before it is kept. */
export function Gate({ onUnlock }: { onUnlock: (key: string) => void }) {
  const convex = useConvex();
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key) return setError("Paste your dashboard key to continue.");
    setChecking(true);
    setError("");
    try {
      await convex.query(api.dashboard.getStatus, { key });
      onUnlock(key);
    } catch (cause) {
      const message = errorText(cause);
      setError(/dashboard key|DASHBOARD_KEY/i.test(message)
        ? "That key doesn't match this Perry. Copy it again and try once more."
        : `Perry's server didn't answer: ${message}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center text-center">
          <PerryMark className="size-16" />
          <h1 className="mt-5 text-2xl font-semibold tracking-[-0.02em]">Unlock Perry</h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">Enter this installation&apos;s dashboard key. It stays in this browser.</p>
        </div>
        <form onSubmit={(event) => void submit(event)} noValidate className="mt-8 rounded-2xl border bg-card p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.12)]">
          <Field data-invalid={Boolean(error) || undefined}>
            <FieldLabel htmlFor="dashboard-key">Dashboard key</FieldLabel>
            <SecretInput id="dashboard-key" name="dashboard-key" value={value} autoFocus placeholder="Paste your key"
              invalid={Boolean(error)} describedBy={error ? "dashboard-key-error" : undefined}
              onChange={(next) => { setValue(next); setError(""); }} />
            {error && <FieldError id="dashboard-key-error" role="alert">{error}</FieldError>}
          </Field>
          <Button type="submit" size="lg" className="mt-5 h-10 w-full" disabled={checking} aria-busy={checking || undefined}>
            {checking && <Spinner />}{checking ? "Checking…" : "Continue"}
          </Button>
        </form>
        <div className="mt-6 space-y-2 px-1">
          <FieldDescription>Or open it already unlocked from a terminal on this computer:</FieldDescription>
          <CommandLine>perry open</CommandLine>
        </div>
      </div>
    </main>
  );
}
