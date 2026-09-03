// Fill in securities.sector from Yahoo Finance.
// ----------------------------------------------------------------------------
// `securities.sector` has been NULL on all 775 rows since the table was created.
// Nothing ever wrote it: the broker's holdings export carries Account Number,
// Account Name, Security Code, Company Name, Holding Qty, Market Price and
// Average Cost — and no classification — so the import cannot supply one, and
// the demo seed that used to set it went when real securities arrived.
//
// The visible cost was the portfolio Analytics tab, whose sector breakdown
// collapsed to a single bar labelled "Other" for every client. This is what
// makes that chart mean something.
//
// ── Where the classification comes from ─────────────────────────────────────
// `yahoo-finance2` is already a dependency and already quotes ASX prices for the
// options valuation (`fetchSpotPricesAction`), so this uses the same client and
// the same `.AX` symbol convention. `quoteSummary`'s `assetProfile` module
// carries `sector`.
//
// Unlike quotes there is no batched form — `quoteSummary` is one call per symbol
// — so this runs sequentially with a pause between calls. Yahoo rate-limits, and
// a backfill that gets itself blocked half way is worse than one that takes a
// few minutes.
//
// ── What it deliberately does NOT do ───────────────────────────────────────
// It never invents a sector. A symbol Yahoo does not classify — a delisted name,
// an option series, a code that is not ASX-listed at all — is left NULL and
// counted in the summary. "Other" as a real bucket is honest; "Other" because
// nobody looked is not, and the two must stay distinguishable.
//
// Option series are skipped outright rather than looked up: no source classifies
// `ABXO`. They inherit the ordinary's sector at read time through
// `securities.parent_code` (see `toPosition` in lib/data/queries.ts).
//
// Requires the SERVICE ROLE key:
//   npm run backfill:sectors            # only codes that appear in positions
//   npm run backfill:sectors -- --all   # every security row
// ----------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing env. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with: npm run backfill:sectors",
  );
  process.exit(1);
}

const ALL = process.argv.includes("--all");
/** Yahoo tolerates a steady trickle; it does not tolerate 775 calls at once. */
const GAP_MS = 250;

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An option series, by the shapes this register actually uses.
 *
 * `-UO` is the modelled unlisted grant; a trailing `O` or `O`+letter is the
 * broker's listed-option convention (`ABXO`, `ADNOD`). Kept deliberately narrow
 * — a real four-letter ordinary must not be mistaken for a derivative and left
 * unclassified.
 */
const looksLikeOption = (code) => /-UO$/i.test(code) || /^[A-Z0-9]{3}O[A-Z]?$/.test(code);

/**
 * The symbol Yahoo knows this code by.
 *
 * ASX names are quoted with a `.AX` suffix — the same convention
 * `fetchSpotPricesAction` uses. But the register also holds US-listed codes in
 * the broker's `TICKER:EXCHANGE` form (`RKLB:NAS`, `SPCX:NAS`), and appending
 * `.AX` to those asked Yahoo about a symbol that does not exist: the first real
 * run reported them as "no classification" when the problem was the question.
 * Yahoo quotes US names bare.
 */
function yahooSymbol(code) {
  const [base, exchange] = code.split(":");
  return exchange ? base : `${code}.AX`;
}

async function targets() {
  if (ALL) {
    const { data, error } = await db
      .from("securities")
      .select("code,parent_code,sector")
      .is("sector", null);
    if (error) throw error;
    return data ?? [];
  }

  // Only what someone actually holds. 775 rows is mostly history; the chart is
  // about current exposure, and a smaller run is a run that finishes.
  const { data: held, error: heldError } = await db.from("positions").select("security_code");
  if (heldError) throw heldError;

  const holdings = [...new Set((held ?? []).map((r) => r.security_code))];
  if (holdings.length === 0) return [];

  // The ORDINARIES behind held options have to be in scope too, and are easy to
  // miss: an account can hold `ABXO` and never `ABX`, so a run scoped to held
  // codes alone classified the option's parent nowhere — and since options
  // inherit their parent's sector, the row stayed in "Other" no matter how many
  // times this ran. The first real run left ABX, SBR and WHK exactly there.
  const { data: parents, error: parentError } = await db
    .from("securities")
    .select("parent_code")
    .in("code", holdings)
    .not("parent_code", "is", null);
  if (parentError) throw parentError;

  const codes = [
    ...new Set([...holdings, ...(parents ?? []).map((r) => r.parent_code)]),
  ].filter(Boolean);

  const { data, error } = await db
    .from("securities")
    .select("code,parent_code,sector")
    .in("code", codes)
    .is("sector", null);
  if (error) throw error;
  return data ?? [];
}

async function main() {
  const rows = await targets();
  console.log(
    `${rows.length} securit${rows.length === 1 ? "y" : "ies"} without a sector` +
      `${ALL ? "" : " among currently held positions"}.\n`,
  );
  if (rows.length === 0) return;

  const { default: YahooFinance } = await import("yahoo-finance2");
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  let filled = 0;
  let skipped = 0;
  let unknown = 0;

  for (const row of rows) {
    if (looksLikeOption(row.code)) {
      // Inherits the ordinary's sector at read time; looking one up would fail
      // for every option and slow the run down doing it.
      skipped++;
      continue;
    }

    let sector = null;
    try {
      const profile = await yf.quoteSummary(yahooSymbol(row.code), { modules: ["assetProfile"] });
      const value = profile?.assetProfile?.sector;
      sector = typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    } catch {
      // A symbol Yahoo does not know throws rather than answering empty. Left
      // NULL, and counted — never guessed at.
      sector = null;
    }

    if (!sector) {
      unknown++;
      console.log(`  ?  ${row.code.padEnd(10)} no classification`);
    } else {
      const { error } = await db.from("securities").update({ sector }).eq("code", row.code);
      if (error) {
        console.error(`  !  ${row.code.padEnd(10)} ${error.message}`);
      } else {
        filled++;
        console.log(`  ✓  ${row.code.padEnd(10)} ${sector}`);
      }
    }

    await sleep(GAP_MS);
  }

  console.log(
    `\n${filled} classified, ${unknown} unknown to Yahoo, ${skipped} option series skipped` +
      ` (they inherit the ordinary's sector).`,
  );
  if (unknown > 0) {
    console.log(
      "The unknown ones stay NULL and show as \"Other\" — which is the honest answer,\n" +
        "and is why this script never fills a sector it could not look up.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
