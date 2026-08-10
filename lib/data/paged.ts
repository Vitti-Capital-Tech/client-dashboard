import "server-only";

/**
 * Read EVERY row a query matches, not the first thousand.
 *
 * PostgREST caps a response at its `max-rows` setting — 1000 on Supabase — and
 * says nothing about it: no error, no flag, just a short array. `.range()` does
 * not lift the cap; it only moves the window.
 *
 * That is a silent correctness bug wherever a full set is assumed, and this
 * codebase assumed it in places that decide money. One real client holds 1,650
 * contract notes; their Order History, their realised-P&L chart and their
 * Bought/Sold/Fees totals were all computed from the first 1,000 — complete
 * looking, and wrong.
 *
 * The importer has its own copy of this (`lib/import/runner.ts`) because that
 * module must stay free of `server-only` for the CLI. This one is for the DAL.
 *
 *     const trades = await pagedSelect(supabase, "trades", "*",
 *       (q) => q.eq("client_id", id).order("trade_date", { ascending: false }));
 */

/** How many rows PostgREST returns before it silently stops. */
const PAGE = 1000;

/* eslint-disable @typescript-eslint/no-explicit-any -- the PostgREST builder is
 * generic over a schema and chains conditionally; typing it here would describe
 * this helper rather than the client it wraps. */
export async function pagedSelect<T>(
  db: any,
  table: string,
  columns: string,
  filter?: (query: any) => any,
): Promise<T[]> {
  const out: T[] = [];

  for (let from = 0; ; from += PAGE) {
    let query = db.from(table).select(columns).range(from, from + PAGE - 1);
    if (filter) query = filter(query);

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as T[];
    out.push(...page);

    // A short page is the end. Waiting for an empty one instead would cost a
    // wasted round trip whenever the total is an exact multiple of the cap.
    if (page.length < PAGE) return out;
  }
}
