import {
  entityTokens,
  getParentTicker,
  isClientMatch,
  isNonClientAllocationRow,
  placementEntries,
  type PlacementClientAllocation,
  type PlacementTickerInfo,
} from "../pnl-calculator.ts";

/**
 * Propose `clients.placement_aliases` entries — and never write one.
 *
 * ── Why this is a suggester and not a matcher ────────────────────────────────
 * `isClientMatch` normalises how a name is *written* (case, punctuation,
 * `Pty Ltd` ≡ `P/L`, `Inv` ≡ `Investments`) and stops there, because the
 * differences that remain are not spelling. The real workbooks carry
 * `PSG Capital Ltd` and `PSG Super` against two DIFFERENT clients, one word
 * apart. A rule loose enough to bridge the first would bridge the second, and
 * the cost is a placement parcel stored under the wrong client's P&L, where
 * nothing downstream can tell it from a real figure.
 *
 * So the mapping is stated by the desk (§8.23 LLD). What this module does is
 * find the candidates and show the EVIDENCE, in the same spirit as
 * `lib/import/reconcile.ts` proposing a ticker change: propose, never apply.
 *
 * ── The evidence is quantities, not name distance ────────────────────────────
 * An alias only matters where a row's buy side is missing, and exactly there the
 * ledger says how many units are unaccounted for. If precisely one unclaimed
 * participant in that placement holds that number, the sheet has answered the
 * question itself. The real case:
 *
 *     R Chawla & G Vijan PTY LTD — RMI: bought 0, sold 238,095
 *     RMI participants:  Akhil Sobti 238,095 · RG Vijan Super Fund 238,095 ·
 *                        PSG Super Fund 119,048 · Saturn Fund 595,238
 *
 * Quantity cuts eight names to two; the shared token `Vijan` picks one. That is
 * a proposal a person can check in seconds — which is the whole point, because
 * a person still has to.
 */

export type AliasEvidence = {
  ticker: string;
  /** Units the ledger cannot account for: `sellQty - buyQty`. */
  shortfall: number;
  /** What this participant was allocated in that placement. */
  shares: number;
  /** The quantities agree exactly. */
  quantityMatch: boolean;
  /** The names share a distinctive word. */
  nameOverlap: boolean;
};

export type AliasSuggestion = {
  clientId: string;
  displayName: string;
  /** The placement sheet's spelling being proposed as an alias. */
  alias: string;
  /**
   * `high` — quantities agree AND the names share a word.
   * `medium` — quantities agree and nothing contradicts it.
   * `low` — only the names look alike. Reported, never proposed.
   */
  confidence: "high" | "medium" | "low";
  /**
   * Why. Once ANY row reconciles exactly, the rows that merely share a name are
   * dropped from here and counted in `weakerRows` instead — on the real register
   * one alias carried two exact matches and nine near-misses, and printing all
   * eleven buried the two that meant something.
   */
  evidence: AliasEvidence[];
  /** Rows that supported the alias only weakly, and were left out above. */
  weakerRows: number;
  /**
   * The same sheet name was proposed for more than one client.
   *
   * Never emitted as SQL. Two clients wanting one name is precisely the
   * situation that must reach a human — it is how `PSG Super` would otherwise
   * end up on the investments company's P&L.
   */
  conflict: boolean;
  /** The other clients it was proposed for, by name, so the choice is visible. */
  conflictWith: string[];
};

/** One client's ledger-only position in a stock, before any placement merge. */
export type LedgerRow = {
  /** Parent (3-char) ticker, as the placement sheets are keyed. */
  ticker: string;
  buyQty: number;
  sellQty: number;
};

export type ClientLedger = {
  clientId: string;
  displayName: string;
  /** Aliases already configured — a name matching one is not a candidate. */
  aliases: string[];
  /** Ledger-only rows across every account this client holds. */
  rows: LedgerRow[];
};

/**
 * Words that describe a company rather than identify one.
 *
 * Learned from the real register: `Capital` alone proposed `PSG Capital Ltd` for
 * `Placement - Vitti Capital PTY LTD`, two entirely unrelated parties. The rule
 * is that a token only counts as a name if dropping every firm-ish word still
 * leaves it — which is what makes `Vijan`, `Psg` and `Chawla` signal and
 * `Capital`, `Investments` and `Fund` noise.
 */
const GENERIC_TOKENS = new Set([
  "ptyltd",
  "ltd",
  "capital",
  "investments",
  "holdings",
  "nominees",
  "services",
  "group",
  "partners",
  "superannuation",
  "superfund",
  "fund",
  "funds",
  "trust",
  "family",
  "placement",
  "the",
  "mr",
  "mrs",
  "ms",
  "dr",
]);

/** The words in a name that could identify somebody. */
function distinctiveTokens(name: string): Set<string> {
  return new Set(
    entityTokens(name).filter((t) => t.length > 2 && !GENERIC_TOKENS.has(t)),
  );
}

function shareAWord(a: string, b: string): boolean {
  const left = distinctiveTokens(a);
  for (const token of distinctiveTokens(b)) if (left.has(token)) return true;
  return false;
}

/**
 * Units the ledger cannot account for.
 *
 * Zero means the contract notes already explain the position, and a row like
 * that needs no placement and therefore no alias — which is also why a client
 * who simply bought on-market in a placed stock generates no suggestions.
 */
function shortfallOf(row: LedgerRow): number {
  if (row.buyQty === 0) return row.sellQty;
  return row.sellQty > row.buyQty ? row.sellQty - row.buyQty : 0;
}

export function suggestPlacementAliases(
  clients: ClientLedger[],
  placements: Map<string, PlacementTickerInfo>,
): AliasSuggestion[] {
  // Every name already spoken for, by ANY client. A participant that resolves to
  // someone else is not a candidate for this client — that check is what keeps a
  // suggestion from crossing two real clients.
  const claimed = clients.flatMap((c) => [c.displayName, ...c.aliases]);
  const isClaimed = (name: string) => claimed.some((known) => isClientMatch(name, known));

  // clientId → alias → evidence
  const byClient = new Map<string, Map<string, AliasEvidence[]>>();

  for (const client of clients) {
    const known = [client.displayName, ...client.aliases];

    for (const row of client.rows) {
      const shortfall = shortfallOf(row);
      if (shortfall <= 0) continue;

      const info = placements.get(row.ticker) ?? placements.get(getParentTicker(row.ticker));
      if (!info) continue;

      // A placement this client is already matched in needs no alias, and its
      // other participants are strangers rather than candidates.
      const participants: PlacementClientAllocation[] = [];
      let alreadyMine = false;
      for (const entry of placementEntries(info)) {
        for (const alloc of entry.clientAllocations ?? []) {
          if (known.some((k) => isClientMatch(alloc.clientName, k))) alreadyMine = true;
          participants.push(alloc);
        }
      }
      if (alreadyMine) continue;

      for (const alloc of participants) {
        if (!alloc.clientName || isClaimed(alloc.clientName)) continue;
        // A sheet's own arithmetic is not a client, and its total reconciles with
        // a shortfall often enough to look convincing. The parser drops these
        // rows now, but a cache parsed before that change still carries them —
        // and "add `Total Confirmation` as a client alias" is not a sentence this
        // script may ever print.
        if (isNonClientAllocationRow(alloc.clientName)) continue;

        const quantityMatch = alloc.roundShares === shortfall;
        const nameOverlap = shareAWord(alloc.clientName, client.displayName);
        if (!quantityMatch && !nameOverlap) continue;

        const perAlias = byClient.get(client.clientId) ?? new Map<string, AliasEvidence[]>();
        const evidence = perAlias.get(alloc.clientName) ?? [];
        evidence.push({
          ticker: row.ticker,
          shortfall,
          shares: alloc.roundShares,
          quantityMatch,
          nameOverlap,
        });
        perAlias.set(alloc.clientName, evidence);
        byClient.set(client.clientId, perAlias);
      }
    }
  }

  const out: AliasSuggestion[] = [];
  const proposedFor = new Map<string, Set<string>>();

  for (const client of clients) {
    for (const [alias, all] of byClient.get(client.clientId) ?? []) {
      // Once anything reconciles exactly, the near-misses are not evidence —
      // they are the same two names appearing in other placements, which proves
      // nothing and hides the rows that do.
      const exact = all.filter((e) => e.quantityMatch);
      const evidence = exact.length > 0 ? exact : all;
      const name = evidence.some((e) => e.nameOverlap);

      out.push({
        clientId: client.clientId,
        displayName: client.displayName,
        alias,
        confidence: exact.length > 0 ? (name ? "high" : "medium") : "low",
        evidence,
        weakerRows: all.length - evidence.length,
        conflict: false,
        conflictWith: [],
      });

      const owners = proposedFor.get(alias) ?? new Set<string>();
      owners.add(client.displayName);
      proposedFor.set(alias, owners);
    }
  }

  for (const s of out) {
    const owners = proposedFor.get(s.alias) ?? new Set<string>();
    s.conflict = owners.size > 1;
    s.conflictWith = [...owners].filter((n) => n !== s.displayName);
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      a.displayName.localeCompare(b.displayName) ||
      a.alias.localeCompare(b.alias),
  );
}

/**
 * The statements to paste — only the suggestions that carry BOTH kinds of
 * evidence and that nobody else claims.
 *
 * `medium` (an exact quantity, no name signal) is deliberately not offered, and
 * the real register is why: placement parcels are round numbers drawn from a
 * short list, so quantities collide by coincidence. `Placement - Vitti Capital
 * PTY LTD` reconciles exactly with `PSG Capital Pty Ltd`'s CXO parcel and is
 * plainly not that company. `low` and anything two clients both want are
 * excluded for the same reason. All of them are still PRINTED — to be judged by
 * someone who knows the register, which is the one thing this module cannot do.
 */
export function aliasUpdateSql(suggestions: AliasSuggestion[]): string[] {
  const safe = suggestions.filter((s) => s.confidence === "high" && !s.conflict);

  const byClient = new Map<string, { displayName: string; aliases: string[] }>();
  for (const s of safe) {
    const entry = byClient.get(s.clientId) ?? { displayName: s.displayName, aliases: [] };
    entry.aliases.push(s.alias);
    byClient.set(s.clientId, entry);
  }

  return [...byClient.values()].map(({ displayName, aliases }) => {
    const list = aliases.map((a) => `'${a.replace(/'/g, "''")}'`).join(", ");
    // Appends rather than replaces: an alias already configured by hand must not
    // be dropped by a later run of this script.
    return (
      `UPDATE clients\n` +
      `   SET placement_aliases = ARRAY(SELECT DISTINCT unnest(placement_aliases || ARRAY[${list}]))\n` +
      ` WHERE display_name = '${displayName.replace(/'/g, "''")}';`
    );
  });
}
