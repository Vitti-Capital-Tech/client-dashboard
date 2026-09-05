// Fill in securities.sector — from the ASX company directory first, Yahoo after.
// ----------------------------------------------------------------------------
// `securities.sector` has been NULL on most of the 775 rows since the table was
// created. Nothing ever wrote it: the broker's holdings export carries Account
// Number, Account Name, Security Code, Company Name, Holding Qty, Market Price
// and Average Cost — and no classification — so the import cannot supply one,
// and the demo seed that used to set it went when real securities arrived.
//
// The visible cost is the portfolio sector chart, where most of the book sits
// in a slice called "Other". This is what makes that chart mean something.
//
// ── Why the ASX directory is now the primary source ────────────────────────
// The first version of this script asked Yahoo, one `quoteSummary` call per
// symbol, and got 120-odd of 775 rows classified: Yahoo knows the large caps
// and does not carry an `assetProfile.sector` for much of the ASX small-cap
// tail, which is most of this register.
//
// The ASX publishes the classification itself, for every listed company, as one
// CSV — code, company name, GICS industry group. One HTTP request covers the
// whole market, there is no rate limit to nurse, and for an ASX-listed name it
// is the authority rather than a third party's reading of it. Yahoo is kept as
// the fallback, for the US-listed codes the register also holds (`RKLB:NAS`)
// and for anything the directory has dropped.
//
// ── One vocabulary ─────────────────────────────────────────────────────────
// The two sources name sectors differently — Yahoo's "Basic Materials" and the
// ASX's "Materials" are one thing — and the directory publishes the 24 GICS
// *industry groups* rather than the 11 sectors. Everything is put through
// `canonicalSector` (lib/pnl/sector-labels.ts) before it is written, so the
// column holds one name per sector whichever source answered.
//
// ── What it deliberately does NOT do ───────────────────────────────────────
// It never invents a sector. A code neither source classifies — a delisted
// name, a code that is not listed at all — is left NULL and counted in the
// summary. "Other" as a real bucket is honest; "Other" because nobody looked is
// not, and the two must stay distinguishable.
//
// Derivatives are skipped outright rather than looked up: no source classifies
// `ABXO` or `EOSXX`. They inherit the ordinary's sector at read time through
// `securities.parent_code` (see `toPosition` in lib/data/queries.ts).
//
// Requires the SERVICE ROLE key:
//   npm run backfill:sectors                 # only codes that appear in positions
//   npm run backfill:sectors -- --all        # every security row
//   npm run backfill:sectors -- --all --refresh   # re-classify rows that already have one
//   npm run backfill:sectors -- --all --dry-run   # say what it would write, write nothing
// ----------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";
import { canonicalSector } from "../lib/pnl/sector-labels.ts";

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
/**
 * Re-classify rows that already carry a sector.
 *
 * Off by default, because the common run is "fill in what is missing". Worth
 * doing after this script changed source: the rows Yahoo classified are correct
 * but coarse ("Healthcare" for a diagnostics company that GICS puts under
 * Health Care Equipment & Services), and a refresh puts the whole column on the
 * ASX's own classification.
 */
const REFRESH = process.argv.includes("--refresh");

/** Report what would be written, and write nothing. */
const DRY_RUN = process.argv.includes("--dry-run");

/** Yahoo tolerates a steady trickle; it does not tolerate hundreds at once. */
const GAP_MS = 250;

/**
 * The ASX listed-companies directory, as CSV.
 *
 * This is the file behind "Download the ASX company list" on asx.com.au — the
 * access token is the public one the site itself uses. Columns: ASX code,
 * Company name, GICs industry group, Listing date, Market cap.
 */
const ASX_DIRECTORY_URL =
  "https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file" +
  "?access_token=83ff96335c2d45a094df02a206a39ff4";

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A derivative, by the shapes this register actually uses.
 *
 * `-UO` is the modelled unlisted grant; a trailing `O` or `O`+letter is the
 * broker's listed-option convention (`ABXO`, `ADNOD`); the doubled suffixes
 * (`EOSXX`, `ADGYY`, `MNEZZ`) are its rights and secondary series. Kept
 * deliberately narrow — a real four-letter ordinary must not be mistaken for a
 * derivative and left unclassified — and it is only a fallback: a row that
 * carries `parent_code` is known to be one without any pattern matching.
 */
const looksLikeDerivative = (code) =>
  /-UO$/i.test(code) ||
  /^[A-Z0-9]{3}O[A-Z]?$/.test(code) ||
  /^[A-Z0-9]{2,4}(XX|YY|ZZ)$/.test(code);

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

/** The ASX code inside a register code: 'RKLB:NAS' → 'RKLB', 'BHP' → 'BHP'. */
const baseCode = (code) => code.split(":")[0].toUpperCase();

/**
 * code → GICS industry group, for every company the ASX lists.
 *
 * Parsed with a regex on the quoted fields rather than a CSV library: company
 * names contain commas ("WESFARMERS LIMITED, THE") but no quotes, and the file
 * quotes every text field, so the first three fields come off unambiguously and
 * the numeric tail is not needed.
 */
async function asxDirectory() {
  const response = await fetch(ASX_DIRECTORY_URL, {
    headers: { accept: "text/csv" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`ASX directory: HTTP ${response.status} ${response.statusText}`);
  }

  const map = new Map();
  for (const line of (await response.text()).split(/\r?\n/).slice(1)) {
    const fields = line.match(/^"([^"]*)","([^"]*)","([^"]*)"/);
    if (fields) map.set(fields[1].toUpperCase(), fields[3]);
  }
  if (map.size < 500) {
    // The whole market is ~1,800 rows. Anything much under that means the file
    // changed shape, and quietly classifying a third of the register off a
    // half-parsed file is worse than stopping.
    throw new Error(`ASX directory: parsed only ${map.size} rows — has the format changed?`);
  }
  return map;
}

async function targets() {
  const wanted = (query) => (REFRESH ? query : query.is("sector", null));

  if (ALL) {
    const { data, error } = await wanted(
      db.from("securities").select("code,parent_code,sector"),
    );
    if (error) throw error;
    return data ?? [];
  }

  // Only what someone actually holds. 775 rows is mostly history; the chart is
  // about current exposure, and a smaller run is a run that finishes.
  const { data: held, error: heldError } = await db.from("positions").select("security_code");
  if (heldError) throw heldError;

  const holdings = [...new Set((held ?? []).map((r) => r.security_code))];
  if (holdings.length === 0) return [];

  // The ORDINARIES behind held derivatives have to be in scope too, and are easy
  // to miss: an account can hold `ABXO` and never `ABX`, so a run scoped to held
  // codes alone classified the option's parent nowhere — and since derivatives
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

  const { data, error } = await wanted(
    db.from("securities").select("code,parent_code,sector").in("code", codes),
  );
  if (error) throw error;
  return data ?? [];
}

async function main() {
  const rows = await targets();
  console.log(
    `${rows.length} securit${rows.length === 1 ? "y" : "ies"} to classify` +
      `${ALL ? "" : " among currently held positions"}` +
      `${REFRESH ? " (including ones already classified)" : ""}.\n`,
  );
  if (rows.length === 0) return;

  const directory = await asxDirectory();
  console.log(`ASX directory: ${directory.size} listed companies.\n`);

  let fromAsx = 0;
  let fromYahoo = 0;
  let skipped = 0;
  let unchanged = 0;
  let unknown = 0;
  const unknownCodes = [];

  // Yahoo is only reached for what the directory could not answer, so the client
  // is built lazily: a run that the ASX covers completely makes no Yahoo calls
  // and does not pay for the import.
  let yf = null;
  const yahoo = async () => {
    if (!yf) {
      const { default: YahooFinance } = await import("yahoo-finance2");
      yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
    }
    return yf;
  };

  for (const row of rows) {
    // A row with a parent IS a derivative, whatever its code looks like.
    if (row.parent_code || looksLikeDerivative(row.code)) {
      skipped++;
      continue;
    }

    let sector = canonicalSector(directory.get(baseCode(row.code)));
    let source = "asx";

    if (!sector) {
      try {
        const client = await yahoo();
        const profile = await client.quoteSummary(yahooSymbol(row.code), {
          modules: ["assetProfile"],
        });
        sector = canonicalSector(profile?.assetProfile?.sector);
        source = "yahoo";
      } catch {
        // A symbol Yahoo does not know throws rather than answering empty. Left
        // NULL, and counted — never guessed at.
        sector = null;
      }
      await sleep(GAP_MS);
    }

    if (!sector) {
      unknown++;
      unknownCodes.push(row.code);
      console.log(`  ?  ${row.code.padEnd(10)} no classification`);
      continue;
    }

    if (sector === row.sector) {
      unchanged++;
      continue;
    }

    if (!DRY_RUN) {
      const { error } = await db.from("securities").update({ sector }).eq("code", row.code);
      if (error) {
        console.error(`  !  ${row.code.padEnd(10)} ${error.message}`);
        continue;
      }
    }

    if (source === "asx") fromAsx++;
    else fromYahoo++;
    console.log(`  ✓  ${row.code.padEnd(10)} ${sector}  (${source})`);
  }

  console.log(
    `\n${fromAsx} classified from the ASX directory, ${fromYahoo} from Yahoo, ` +
      `${unchanged} already correct, ${unknown} unclassified, ` +
      `${skipped} derivatives skipped (they inherit the ordinary's sector).`,
  );
  if (unknown > 0) {
    console.log(
      `Unclassified: ${unknownCodes.join(", ")}\n` +
        'These stay NULL and show as "Other" — which is the honest answer, and is\n' +
        "why this script never fills a sector it could not look up.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
