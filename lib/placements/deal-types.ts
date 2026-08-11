/**
 * The `placements.type` vocabulary.
 *
 * ── Why this is not in `app/actions/placements.ts` ───────────────────────────
 * It was, and that was a bug. A `"use server"` module may only export async
 * functions: everything else is replaced by a server reference on the way to
 * the client, so a client component importing this const received something
 * that was not an array. It typechecked, it built, and it crashed at runtime
 * with `r.map is not a function` — but only once the promote form opened, since
 * that is the only place the value is read.
 *
 * A plain module has no such rule, and both the action and the form can import
 * from it.
 *
 * ── Why the values look like this ────────────────────────────────────────────
 * They are the enum from the first migration, exactly. Note there is no plain
 * `IPO`: the deal-mail feed classifies raises as `Placement | IPO`, and the
 * nearest value here is `Pre-IPO`. That mapping is a judgement rather than a
 * translation, which is why the promote form defaults it and leaves it editable
 * instead of deciding silently.
 */
export const PLACEMENT_TYPES = ["Placement", "SPP", "Pre-IPO", "Rights"] as const;

export type PlacementType = (typeof PLACEMENT_TYPES)[number];

/** The terms the deal mail never carried, supplied by whoever promotes it. */
export type PromotionTerms = {
  code: string;
  name: string;
  type: PlacementType;
  price: number;
  raiseMillions: number;
  minBid: number;
  opts?: string | null;
  closeDate?: string | null;
};
