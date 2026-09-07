"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Mail, MonitorSmartphone, CheckCircle2 } from "lucide-react";
import {
  changePassword,
  startEmailChange,
  signOutEverywhere,
  type ActionResult,
} from "@/app/actions/profile";
import { requestPasswordResetCode, resetPassword } from "@/app/actions/session";
import { PasswordInput } from "@/app/components/PasswordInput";
import { CodeInput, CODE_LENGTH, emptyCode, codeComplete } from "@/app/components/CodeInput";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

type AccountLine = {
  id: string;
  label: string;
  externalRef: string | null;
  accountType: string;
};

/**
 * The three things a client can change about their login, one card each.
 *
 * Each card owns its own busy state and its own message. One shared "saving…"
 * flag would disable all three while any one of them ran, and one shared message
 * area would show "Password updated" under the email form.
 */
export function SettingsClient({
  name,
  email,
  hasPassword,
  accounts,
  emailNotice,
}: {
  name: string;
  email: string;
  hasPassword: boolean;
  accounts: AccountLine[];
  emailNotice: "confirmed" | "invalid" | null;
}) {
  return (
    <div className="space-y-5 text-ink font-body max-w-160">
      <div className="select-none">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">
          Your login
        </div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Settings</h1>
        <p className="text-xs text-mut mt-1">
          Your sign-in details and the devices you are signed in on. Holdings and
          account requests live under Accounts.
        </p>
      </div>

      {emailNotice === "confirmed" && (
        <Banner tone="good">
          Email confirmed. If both the old and the new address have now been
          confirmed, your login has moved — sign in with the new address next
          time.
        </Banner>
      )}
      {emailNotice === "invalid" && (
        <Banner tone="bad">
          That confirmation link is not valid or has expired. Start the change
          again below.
        </Banner>
      )}

      <Details name={name} email={email} accounts={accounts} />
      {hasPassword ? <ChangePassword /> : <SetFirstPassword email={email} />}
      <ChangeEmail current={email} />
      <Sessions />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only header
// ---------------------------------------------------------------------------
function Details({
  name,
  email,
  accounts,
}: {
  name: string;
  email: string;
  accounts: AccountLine[];
}) {
  return (
    <Card title="Your details">
      <dl className="space-y-3">
        <Row label="Name" value={name} />
        <Row label="Login email" value={email} mono />
        <div>
          <dt className="text-xs font-semibold text-mut mb-1.5">
            Accounts on this login ({accounts.length})
          </dt>
          <dd className="space-y-1.5">
            {accounts.length === 0 ? (
              <span className="text-[13.5px] text-mut">None linked yet.</span>
            ) : (
              accounts.map((a) => (
                <div
                  key={a.id}
                  className="flex items-baseline justify-between gap-4 bg-paper-2 rounded-[9px] px-3 py-2"
                >
                  <span className="text-[13.5px] font-semibold">{a.label}</span>
                  <span className="font-mono text-xs text-mut">
                    {a.externalRef ?? "—"}
                  </span>
                </div>
              ))
            )}
          </dd>
          <p className="text-[11.5px] text-mut mt-2">
            One login can hold several accounts. Add another from Accounts.
          </p>
        </div>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Password — for someone who already has one
// ---------------------------------------------------------------------------
function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { busy, result, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => changePassword(current, next, confirmation), () => {
      setCurrent("");
      setNext("");
      setConfirmation("");
    });
  };

  return (
    <Card title="Password" icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <PasswordInput
          id="current-password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          placeholder="••••••••••"
        />
        <PasswordInput
          id="new-password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          placeholder="••••••••••"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number.`}
        />
        <PasswordInput
          id="confirm-password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirmation}
          onChange={setConfirmation}
          placeholder="••••••••••"
        />

        <Feedback result={result} />

        <Submit
          busy={busy}
          disabled={!current || !next || !confirmation}
          label="Update password"
          busyLabel="Updating…"
        />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Password — for someone who has only ever used a code
// ---------------------------------------------------------------------------
/**
 * Every login the broker import or `client:login` created has no password. Such
 * a client cannot be asked for a current one — so the mailbox stands in for it,
 * through the same code flow the reset page uses.
 *
 * Not simply "let them set one because they are signed in": a session is proof
 * of access now, a password is access indefinitely, and an open session on a
 * borrowed laptop should not be convertible into the second.
 */
function SetFirstPassword({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const [digits, setDigits] = useState<string[]>(emptyCode);
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { busy, result, run, setResult } = useAction();
  const router = useRouter();

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () => requestPasswordResetCode(email).then((r) => (r.ok ? { ok: true as const } : r)),
      () => {
        setDigits(emptyCode());
        setSent(true);
      },
    );
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      async () => {
        const r = await resetPassword(email, digits.join(""), next);
        return r.ok ? { ok: true as const, message: "Password set. You can now sign in with it." } : r;
      },
      () => {
        setNext("");
        setConfirmation("");
        setDigits(emptyCode());
        setSent(false);
        // `hasPassword` is resolved on the server, so the card only becomes the
        // change-password form after a refresh.
        router.refresh();
      },
    );
  };

  return (
    <Card title="Password" icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}>
      <p className="text-[13.5px] text-mut leading-relaxed mb-4">
        You sign in with a one-time code and have no password yet. Setting one is
        optional — the code will keep working either way.
      </p>

      {!sent ? (
        <form onSubmit={send} className="space-y-4" noValidate>
          <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
            We will email a {CODE_LENGTH}-digit code to{" "}
            <span className="font-semibold text-ink break-all">{email}</span> to
            confirm it is you.
          </p>
          <Feedback result={result} />
          <Submit busy={busy} label="Email me a code" busyLabel="Sending…" />
        </form>
      ) : (
        <form onSubmit={save} className="space-y-4" noValidate>
          <CodeInput
            digits={digits}
            onChange={setDigits}
            onError={(m) => setResult({ ok: false, error: m })}
            disabled={busy}
          />
          <PasswordInput
            id="first-password"
            label="New password"
            autoComplete="new-password"
            value={next}
            onChange={setNext}
            placeholder="••••••••••"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number.`}
          />
          <PasswordInput
            id="first-password-confirm"
            label="Confirm new password"
            autoComplete="new-password"
            value={confirmation}
            onChange={setConfirmation}
            placeholder="••••••••••"
          />
          <Feedback result={result} />
          <Submit
            busy={busy}
            disabled={!codeComplete(digits) || !next || next !== confirmation}
            label="Set password"
            busyLabel="Saving…"
          />
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Login email
// ---------------------------------------------------------------------------
function ChangeEmail({ current }: { current: string }) {
  const [next, setNext] = useState("");
  const { busy, result, run } = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => startEmailChange(next), () => setNext(""));
  };

  return (
    <Card title="Login email" icon={<Mail className="w-4 h-4" aria-hidden="true" />}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-[13.5px] text-mut leading-relaxed">
          Your login is{" "}
          <span className="font-semibold text-ink break-all">{current}</span>.
          Changing it needs confirmation from <strong>both</strong> the old and
          the new address, so nobody can move your login on their own.
        </p>

        <div className="space-y-1.5">
          <label htmlFor="new-email" className="block text-xs font-semibold text-ink">
            New email
          </label>
          <input
            id="new-email"
            name="new-email"
            type="email"
            autoComplete="email"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="you@example.com"
            required
            className="w-full border border-line-2 bg-white rounded-[10px] px-3.5 py-3 text-[15px] focus:border-green focus:outline-none transition-colors"
          />
        </div>

        <Feedback result={result} />

        <Submit
          busy={busy}
          disabled={next.trim() === ""}
          label="Send confirmations"
          busyLabel="Sending…"
        />

        <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
          Nothing changes until both are confirmed. Keep using your current
          address to sign in until then.
        </p>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function Sessions() {
  const router = useRouter();
  const { busy, result, run } = useAction();

  const submit = () =>
    run(signOutEverywhere, () => {
      // This session is one of the ones just ended, so there is nowhere to stay.
      router.push("/login");
    });

  return (
    <Card
      title="Devices"
      icon={<MonitorSmartphone className="w-4 h-4" aria-hidden="true" />}
    >
      <p className="text-[13.5px] text-mut leading-relaxed mb-4">
        Signs you out of every browser and device, including this one. Use it if
        you have signed in somewhere you no longer have.
      </p>
      <Feedback result={result} />
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="btn rounded-[10px] py-2.5 px-4 text-[13px] font-semibold cursor-pointer select-none border border-line-2 bg-white text-loss-d hover:bg-loss-bg transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
      >
        {busy ? "Signing out…" : "Sign out everywhere"}
      </button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------
/** One card's worth of busy state, result, and the transition that drives it. */
function useAction() {
  const [busy, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const run = (fn: () => Promise<ActionResult>, onOk?: () => void) => {
    setResult(null);
    startTransition(async () => {
      try {
        const r = await fn();
        setResult(r);
        if (r.ok) onOk?.();
      } catch (e) {
        setResult({
          ok: false,
          error: e instanceof Error ? e.message : "Something went wrong.",
        });
      }
    });
  };

  return { busy, result, run, setResult };
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line flex items-center gap-2 select-none">
        {icon && <span className="text-mut">{icon}</span>}
        <b className="text-sm font-semibold text-ink">{title}</b>
      </div>
      <div className="px-4.5 py-4">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs font-semibold text-mut">{label}</dt>
      <dd
        className={`text-[13.5px] font-semibold break-all text-right ${mono ? "font-mono text-xs" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Feedback({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <p
        role="alert"
        className="text-[12.5px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-[9px] px-3 py-2"
      >
        {result.error}
      </p>
    );
  }
  if (!result.message) return null;
  return (
    <p
      role="status"
      className="text-[12.5px] font-semibold text-green-d bg-green-bg rounded-[9px] px-3 py-2 flex items-start gap-2"
    >
      <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
      <span>{result.message}</span>
    </p>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "good" | "bad";
  children: React.ReactNode;
}) {
  return (
    <p
      role="status"
      className={`text-[13px] font-semibold rounded-[10px] px-3.5 py-3 leading-relaxed ${
        tone === "good"
          ? "text-green-d bg-green-bg"
          : "text-red-700 bg-red-50 border border-red-200"
      }`}
    >
      {children}
    </p>
  );
}

function Submit({
  busy,
  disabled = false,
  label,
  busyLabel,
}: {
  busy: boolean;
  disabled?: boolean;
  label: string;
  busyLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="btn rounded-[10px] py-2.5 px-4 text-[13px] font-semibold cursor-pointer select-none bg-navy text-white hover:bg-slate-800 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
    >
      {busy ? busyLabel : label}
    </button>
  );
}
