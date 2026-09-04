import type { ClaimRequestRow } from "@/lib/data/queries";

/**
 * What a newly registered client sees while their first account claim is with
 * the desk.
 *
 * ── Why not just render the dashboard ───────────────────────────────────────
 * Because every figure on it would be zero, and zero is a claim about their
 * money rather than a claim about our data. A portfolio reading $0.00, an empty
 * holdings table and "no open placements" is indistinguishable from a client
 * whose account really is empty — the one reading that is worse than an error,
 * because it looks authoritative. This screen says the true thing instead: we
 * have not connected your account yet.
 *
 * ── Why it replaces `children` rather than sitting on top of them ───────────
 * The whole portal is account-scoped: `getActiveAccountId()` returns "" for a
 * client with no accounts, and six pages hand that to the DAL. Rendering this in
 * the layout means none of them run, so there is one place that knows about the
 * state instead of six that each have to survive it. The nav stays live and
 * every destination lands back here, which is the correct answer for all of
 * them right now.
 */
export function AwaitingAccount({ claim }: { claim: ClaimRequestRow }) {
  const requested = new Date(claim.requestedAt).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="max-w-140 mx-auto py-6 text-ink font-body">
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-6 py-5 border-b border-line flex items-start gap-3.5">
          <span className="shrink-0 w-9 h-9 rounded-full bg-amber-bg grid place-items-center">
            <svg
              className="w-4.5 h-4.5 fill-none stroke-amber-d stroke-2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5l3 2" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <div className="font-mono text-xs tracking-wider uppercase text-mut">
              Account verification
            </div>
            <h1 className="font-disp font-medium text-[22px] mt-0.5 leading-snug">
              We are linking your account
            </h1>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4 text-[13.5px] leading-relaxed">
          <p className="text-mut">
            Your registration is complete and your sign-in works. Before your
            holdings, placements and profit &amp; loss can appear here, the Vitti
            desk checks the account number you gave us against the broker record.
          </p>

          <dl className="bg-paper-2 rounded-[10px] p-4 space-y-2.5">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs font-semibold text-mut">Account number</dt>
              <dd className="font-mono text-sm font-semibold">
                {claim.accountNumber}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs font-semibold text-mut">Submitted</dt>
              <dd className="text-sm font-semibold">{requested}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-xs font-semibold text-mut">Status</dt>
              <dd>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-d bg-amber-bg px-2.5 py-1 rounded-full">
                  Awaiting desk approval
                </span>
              </dd>
            </div>
          </dl>

          <p className="text-mut">
            Nothing further is needed from you. The portal opens as soon as the
            desk approves it — you do not need to submit the number again, and
            submitting it twice only gives the desk two requests to reconcile.
          </p>

          <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3">
            Wrong number, or nothing has happened for a few days? Speak to your
            adviser — they can see this request on the desk&apos;s Account
            requests queue.
          </p>
        </div>
      </div>
    </div>
  );
}
