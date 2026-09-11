"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Mail, MonitorSmartphone, CheckCircle2, Palette, Users } from "lucide-react";
import { CustomiseClient } from "@/app/components/CustomiseClient";
import { LeavingOverlay } from "@/app/components/LeavingOverlay";
import { LEAVING_MS, SESSIONS_ENDED_TIPS } from "@/lib/ui/leaving";
import {
  changePassword,
  startEmailChange,
  confirmEmailChange,
  signOutEverywhere,
  type ActionResult,
} from "@/app/actions/profile";
import { requestPasswordResetCode, resetPassword } from "@/app/actions/session";
import {
  startAddLoginEmail,
  confirmAddLoginEmail,
  removeLoginEmail,
  setPrimaryLoginEmail,
  type LoginEmail,
} from "@/app/actions/emails";
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
  logins,
  emailNotice,
}: {
  name: string;
  email: string;
  hasPassword: boolean;
  accounts: AccountLine[];
  logins: LoginEmail[];
  emailNotice: "confirmed" | "invalid" | null;
}) {
  return (
    <div className="space-y-5 text-ink font-body">
      <div className="select-none max-w-160">
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

      {/*
        Two columns from `lg`, one below it.

        It was a single 640px column, which on a desk monitor left two thirds of
        the screen empty and put "Devices" three scrolls below "Your details" —
        a page that reads as long when it holds four short cards.

        The pairing is not arbitrary. Left is who you are and how you get in:
        the account, who can sign in to it, then the password. Right is what
        changes and what ends: your own login address, then every session.
        `items-start` so each card is its own height — stretching them to match
        would leave whitespace inside the shorter one, which is the same problem
        moved indoors.

        "Who can sign in" sits directly under the details it expands on, and
        deliberately far from "Login email" in the other column: the two are
        one keystroke apart in meaning and opposite in effect.
      */}
      <div className="grid lg:grid-cols-2 gap-5 items-start max-w-5xl">
        <div className="space-y-5">
          <Details name={name} email={email} accounts={accounts} logins={logins} />
          <Logins logins={logins} />
          {hasPassword ? <ChangePassword /> : <SetFirstPassword email={email} />}
        </div>
        <div className="space-y-5">
          <ChangeEmail current={email} />
          <Sessions />
        </div>
      </div>

      <Appearance name={name} />
    </div>
  );
}

/**
 * The theme editor, in the page rather than one click away from it.
 *
 * Customise was a nav tab, then a card here linking to its own route. Both were
 * a door in front of a door: it is a preference, it belongs with the other
 * preferences, and a preference you have to navigate to is one people do not
 * find. The route is gone and this is the only place it lives.
 *
 * Rendered outside the narrow column the login cards sit in — the editor is a
 * palette, a preview and a font list, and 640px is not enough for it.
 */
function Appearance({ name }: { name: string }) {
  return (
    <section className="pt-1">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mut mb-3 select-none">
        <Palette className="w-4 h-4 text-green-d" aria-hidden="true" />
        <span>Appearance</span>
      </div>
      <CustomiseClient clientName={name} embedded />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Read-only header
// ---------------------------------------------------------------------------
function Details({
  name,
  email,
  accounts,
  logins,
}: {
  name: string;
  email: string;
  accounts: AccountLine[];
  logins: LoginEmail[];
}) {
  return (
    <Card title="Your details">
      <dl className="space-y-3">
        <Row label="Name" value={name} />
        {/* "Signed in as" rather than "Login email": there may be several, and
            this row is about THIS browser. The full list is the next card. */}
        <Row label="Signed in as" value={email} mono />
        {logins.length > 1 && (
          <Row
            label="Other logins"
            value={`${logins.length - 1} more address${logins.length > 2 ? "es" : ""}`}
          />
        )}
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
// Logins — every address that reaches this account
// ---------------------------------------------------------------------------
/**
 * ── Why this is a separate card from "Login email" ─────────────────────────
 * They read as the same thing and are opposites. This ADDS a way in and leaves
 * the others working; the card below MOVES the address you are signed in as,
 * and the old one stops working. Merged into one card, the difference would
 * come down to which button somebody pressed — and the consequence of guessing
 * wrong is either a second person who cannot get in or a second person who
 * still can when they should not.
 *
 * ── Why the list is rendered even when there is one ────────────────────────
 * A client with a single login sees a one-row list and an "Add another"
 * button, which is how they find out this is possible at all. Hiding the list
 * until there are two would mean the feature only exists for people who
 * already know about it.
 */
function Logins({ logins }: { logins: LoginEmail[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [next, setNext] = useState("");
  const [sent, setSent] = useState(false);
  const [digits, setDigits] = useState(emptyCode());
  const { busy, result, run, setResult } = useAction();

  const target = next.trim().toLowerCase();

  const reset = () => {
    setAdding(false);
    setSent(false);
    setNext("");
    setDigits(emptyCode());
    setResult(null);
  };

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => startAddLoginEmail(next), () => {
      setDigits(emptyCode());
      setSent(true);
    });
  };

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => confirmAddLoginEmail(target, digits.join("")), () => {
      setAdding(false);
      setSent(false);
      setNext("");
      setDigits(emptyCode());
      // The list is resolved on the server, so the new row only appears after
      // a refresh.
      router.refresh();
    });
  };

  return (
    <Card title="Who can sign in" icon={<Users className="w-4 h-4" aria-hidden="true" />}>
      <ul className="space-y-1.5 mb-4">
        {logins.map((login) => (
          <li
            key={login.email}
            className="bg-paper-2 rounded-[9px] px-3 py-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
          >
            <div className="min-w-0">
              <span className="font-mono text-xs break-all">{login.email}</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {login.isPrimary && <Tag tone="green">Primary</Tag>}
                {login.isCurrent && <Tag tone="mut">This device</Tag>}
              </div>
            </div>

            {/* The primary address has neither action: it cannot be removed
                (the database refuses it) and it is already primary. Rendering
                disabled buttons there would be two dead controls on the row
                people look at first. */}
            {!login.isPrimary && (
              <div className="flex items-center gap-3 shrink-0">
                <RowAction
                  busy={busy}
                  onClick={() =>
                    run(() => setPrimaryLoginEmail(login.email), () => router.refresh())
                  }
                >
                  Make primary
                </RowAction>
                {/* Not for the address this browser is signed in as: the call
                    would succeed and the person would find out by losing the
                    page they are standing on. */}
                {!login.isCurrent && (
                  <RowAction
                    busy={busy}
                    tone="bad"
                    onClick={() =>
                      run(() => removeLoginEmail(login.email), () => router.refresh())
                    }
                  >
                    Remove
                  </RowAction>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {!adding ? (
        <div className="space-y-3">
          <Feedback result={result} />
          <button
            type="button"
            onClick={() => {
              setResult(null);
              setAdding(true);
            }}
            className="btn rounded-[10px] py-2.5 px-4 text-[13px] font-semibold cursor-pointer select-none bg-navy text-white hover:bg-slate-800 transition-colors"
          >
            Add another address
          </button>
          <p className="text-[11.5px] text-mut leading-relaxed">
            Everyone here sees the same accounts and holdings, signs in with
            their own password, and is recorded separately in the audit trail.
          </p>
        </div>
      ) : !sent ? (
        <form onSubmit={send} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <label htmlFor="add-email" className="block text-xs font-semibold text-ink">
              Their email
            </label>
            <input
              id="add-email"
              name="add-email"
              type="email"
              autoComplete="off"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="them@example.com"
              required
              className="w-full border border-line-2 bg-white rounded-[10px] px-3.5 py-3 text-[15px] focus:border-green focus:outline-none transition-colors"
            />
          </div>

          <Feedback result={result} />

          <Submit
            busy={busy}
            disabled={next.trim() === ""}
            label="Email them a code"
            busyLabel="Sending…"
          />

          <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
            We send a {CODE_LENGTH}-digit code to that address. Nothing is added
            until the code is entered here, so you will need it from them.
          </p>

          <Cancel busy={busy} onClick={reset}>
            Cancel
          </Cancel>
        </form>
      ) : (
        <form onSubmit={confirm} className="space-y-4" noValidate>
          <p className="text-[13.5px] text-mut leading-relaxed">
            Enter the {CODE_LENGTH}-digit code sent to{" "}
            <span className="font-semibold text-ink break-all">{target}</span>.
            They will be able to sign in as soon as it is accepted.
          </p>

          <CodeInput
            digits={digits}
            onChange={setDigits}
            onError={(m) => setResult({ ok: false, error: m })}
            disabled={busy}
          />

          <Feedback result={result} />

          <Submit
            busy={busy}
            disabled={!codeComplete(digits)}
            label="Add this address"
            busyLabel="Adding…"
          />

          <Cancel busy={busy} onClick={reset}>
            Use a different address
          </Cancel>
        </form>
      )}
    </Card>
  );
}

function Tag({ tone, children }: { tone: "green" | "mut"; children: React.ReactNode }) {
  return (
    <span
      className={`text-[10.5px] font-semibold uppercase tracking-wider rounded-full px-2 py-0.5 ${
        tone === "green" ? "text-green-d bg-green-bg" : "text-mut bg-line"
      }`}
    >
      {children}
    </span>
  );
}

function RowAction({
  busy,
  tone = "normal",
  onClick,
  children,
}: {
  busy: boolean;
  tone?: "normal" | "bad";
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors ${
        tone === "bad" ? "text-red-700 hover:text-red-800" : "text-mut hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Cancel({
  busy,
  onClick,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="w-full text-xs font-semibold text-mut hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
    >
      {children}
    </button>
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
/**
 * Two steps, one mailbox: type the new address, then type the code sent to it.
 *
 * `sent` is local rather than derived from the server, and deliberately: the
 * pending address lives in `auth.users.email_change`, which is not on the
 * session payload this page is rendered from. Keeping the step in component
 * state means a reload lands back on the address form — which is the right
 * place to be, since starting again re-sends the code and the person is not
 * stranded on a code screen with no way back.
 */
function ChangeEmail({ current }: { current: string }) {
  const router = useRouter();
  const [next, setNext] = useState("");
  const [sent, setSent] = useState(false);
  const [digits, setDigits] = useState(emptyCode());
  const { busy, result, run, setResult } = useAction();

  const target = next.trim().toLowerCase();

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => startEmailChange(next), () => {
      setDigits(emptyCode());
      setSent(true);
    });
  };

  const confirm = (e: React.FormEvent) => {
    e.preventDefault();
    run(() => confirmEmailChange(digits.join("")), () => {
      setNext("");
      setDigits(emptyCode());
      setSent(false);
      // `current` is resolved on the server, so the card only shows the new
      // address after a refresh.
      router.refresh();
    });
  };

  const startOver = () => {
    setResult(null);
    setDigits(emptyCode());
    setSent(false);
  };

  return (
    <Card title="Login email" icon={<Mail className="w-4 h-4" aria-hidden="true" />}>
      {!sent ? (
        <form onSubmit={send} className="space-y-4" noValidate>
          <p className="text-[13.5px] text-mut leading-relaxed">
            Your login is{" "}
            <span className="font-semibold text-ink break-all">{current}</span>.
            We will email a {CODE_LENGTH}-digit code to the new address to
            confirm you can reach it.
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
            label="Email me a code"
            busyLabel="Sending…"
          />

          <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
            Nothing changes until you enter the code. Keep using your current
            address to sign in until then.
          </p>
        </form>
      ) : (
        <form onSubmit={confirm} className="space-y-4" noValidate>
          <p className="text-[13.5px] text-mut leading-relaxed">
            Enter the {CODE_LENGTH}-digit code we sent to{" "}
            <span className="font-semibold text-ink break-all">{target}</span>.
            Your login changes as soon as it is accepted.
          </p>

          <CodeInput
            digits={digits}
            onChange={setDigits}
            onError={(m) => setResult({ ok: false, error: m })}
            disabled={busy}
          />

          <Feedback result={result} />

          <Submit
            busy={busy}
            disabled={!codeComplete(digits)}
            label="Change my login email"
            busyLabel="Confirming…"
          />

          {/* A typo in the address is only discoverable at this point — the code
              never arrives — so there has to be a way back to the field. */}
          <button
            type="button"
            onClick={startOver}
            disabled={busy}
            className="w-full text-xs font-semibold text-mut hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Use a different address
          </button>
        </form>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function Sessions() {
  const router = useRouter();
  const { busy, result, run } = useAction();
  const [leaving, setLeaving] = useState(false);

  const submit = () =>
    run(signOutEverywhere, async () => {
      setLeaving(true);
      // Held for the length of the panel, so an action that returns quickly
      // does not cut the send-off off mid-draw. This session is one of the ones
      // just ended, so there is nowhere to stay.
      await new Promise((r) => setTimeout(r, LEAVING_MS.sessionsEnded));
      router.push("/login");
    });

  if (leaving) {
    return (
      <LeavingOverlay
        tone="muted"
        title="Every session ended"
        subtitle="Including this one…"
        tips={SESSIONS_ENDED_TIPS}
        durationMs={LEAVING_MS.sessionsEnded}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* A screen and a phone, both closed. */}
            <path pathLength="1" d="M3 5h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
            <path pathLength="1" d="M7 18h6M19 9h3v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V9z" />
          </svg>
        }
      />
    );
  }

  return (
    <Card
      title="Devices"
      icon={<MonitorSmartphone className="w-4 h-4" aria-hidden="true" />}
    >
      {/* Worded away from "sign out", deliberately. The profile menu has a
          Sign out, and the two were reading as the same button in two places
          when they are not remotely the same act: that one ends this session,
          this one ends every session anybody has. */}
      <p className="text-[13.5px] text-mut leading-relaxed mb-4">
        Ends every session on every browser and device, including this one. Use
        it if you have signed in somewhere you no longer have — a shared
        computer, or a phone you no longer own.
      </p>
      <Feedback result={result} />
      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="btn rounded-[10px] py-2.5 px-4 text-[13px] font-semibold cursor-pointer select-none border border-line-2 bg-white text-loss-d hover:bg-loss-bg transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
      >
        {busy ? "Ending sessions…" : "End all sessions"}
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
