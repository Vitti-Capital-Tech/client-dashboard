/**
 * "Something moved on a stock you hold."
 *
 * ── Why this needs thresholds at all ────────────────────────────────────────
 * Every price moves every day. An alert for each one is a feed, not an alert,
 * and the cost of getting this wrong is not a slow page — it is that the client
 * stops opening the bell, and the exercise-window alert that actually mattered
 * goes unread behind forty notices about a 0.4% drift. So the defaults below
 * are deliberately conservative, and all three gates must pass.
 *
 *   MAGNITUDE    the move has to be big enough to be a move
 *   MATERIALITY  the holding has to be big enough for it to matter
 *   BUDGET       no client hears from us more than a few times a day
 *
 * ── Why buckets rather than a single threshold ──────────────────────────────
 * A stock that runs 6% today and 7% tomorrow has not done anything new. A stock
 * that runs 6% and then 14% has. The bucket a move falls in IS the alert key,
 * so a position re-alerts only when it reaches the next band — the same
 * event-not-condition discipline the option ladder uses in `scan.ts`.
 *
 * ── The rule about what these may say ───────────────────────────────────────
 * A move alert reports a fact: the code, the move, the holding. It never says
 * what to do about it, never calls a move good or bad, and never uses the
 * language of opportunity. "SGQ +12.4% today · you hold 40,000 · $18,000" is
 * a fact. "SGQ is running — worth a look" is advice wearing a hint's clothes,
 * and this is a wholesale product where that distinction is the regulatory
 * point. Enforced by a test, as in `scan.ts` and `lib/glossary.ts`.
 */

/**
 * Bands, widest last. A move reports the LARGEST band it clears, so 22% is a
 * 20% event and not also a 5% and a 10% one.
 *
 * Tune here. These are one company-announcement-sized move apart, which is what
 * the bands are trying to separate from ordinary daily noise on small-cap ASX
 * names — where a 4% day is unremarkable.
 */
export const MOVE_BUCKETS = [5, 10, 20] as const;

/**
 * A holding smaller than this is not worth interrupting anyone about.
 *
 * In dollars of current market value, not as a share of the portfolio: the
 * question "would I want to be told" scales with the money, and a client with a
 * small book should still hear about their largest position.
 */
export const MIN_MATERIAL_VALUE = 2_000;

/**
 * The most move alerts one client can be sent in a day.
 *
 * A market-wide selloff moves every holding at once, and thirty alerts saying
 * the same thing thirty times is the failure this whole file is written to
 * avoid. When the budget binds, the BIGGEST movers survive — those are the ones
 * a client would have wanted if they could only have four.
 */
export const DAILY_MOVE_BUDGET = 4;

export type HeldPosition = {
  clientId: string;
  code: string;
  qty: number;
  /** Last price, for sizing the holding. Null when there is no quote. */
  last: number | null;
  /** The day's move, in percent. Null when the feed does not say. */
  changePct: number | null;
};

export type MoveAlert = {
  clientId: string;
  kind: "price";
  severity: "green" | "amber";
  title: string;
  subtitle: string;
  key: string;
};

/** The largest band this move clears, or null when it clears none. */
export function moveBucket(changePct: number | null): number | null {
  if (changePct === null || !Number.isFinite(changePct)) return null;
  const size = Math.abs(changePct);
  return MOVE_BUCKETS.filter((b) => size >= b).at(-1) ?? null;
}

const money = (n: number) =>
  `$${Math.round(n).toLocaleString("en-AU")}`;

/**
 * Today's move alerts for one book.
 *
 * `today` is the desk's date and goes into the key, so a position that clears
 * the same band again tomorrow is a new event — which is right. Yesterday's
 * 12% and today's 12% are two different days of news.
 */
export function movesForBook(positions: HeldPosition[], today: string): MoveAlert[] {
  const byClient = new Map<string, { value: number; move: number; alert: MoveAlert }[]>();

  for (const p of positions) {
    const bucket = moveBucket(p.changePct);
    if (bucket === null || p.last === null || p.changePct === null) continue;

    const value = p.qty * p.last;
    if (value < MIN_MATERIAL_VALUE) continue;

    const up = p.changePct >= 0;
    const alert: MoveAlert = {
      clientId: p.clientId,
      kind: "price",
      // Amber for a fall, green for a rise — the same polarity the rest of the
      // portal uses for money. Neither is a verdict on what to do about it.
      severity: up ? "green" : "amber",
      title: `${p.code} ${up ? "+" : ""}${p.changePct.toFixed(1)}% today`,
      subtitle: [
        `you hold ${p.qty.toLocaleString("en-AU")}`,
        `${money(value)} at ${p.last.toFixed(3)}`,
        `${bucket}% band`,
      ].join(" · "),
      // The band, not the exact percentage: a position drifting from 12.1% to
      // 12.4% within the day must not produce a second row.
      key: `move:${p.code}:${today}:${bucket}`,
    };

    const list = byClient.get(p.clientId) ?? [];
    list.push({ value, move: Math.abs(p.changePct), alert });
    byClient.set(p.clientId, list);
  }

  const out: MoveAlert[] = [];
  for (const list of byClient.values()) {
    // Biggest move first, then biggest holding as the tie-break — on a day when
    // everything moves the same amount, the money decides.
    list.sort((a, b) => b.move - a.move || b.value - a.value);
    out.push(...list.slice(0, DAILY_MOVE_BUDGET).map((x) => x.alert));
  }
  return out;
}
