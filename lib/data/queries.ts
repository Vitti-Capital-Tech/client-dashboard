import "server-only";
import { pagedSelect } from "./paged";
import { cache } from "react";
import { createClient } from "../supabase/server";
import type { Database } from "../supabase/database.types";

/**
 * Data-access layer (read side). Server-only. Every function fetches from
 * Supabase and returns denormalized, UI-ready objects — prices/names that the
 * schema stores once in `securities` are joined back in here, so callers get a
 * flat shape like the old in-memory store did.
 *
 * Identity: entities are keyed by the real `clients.id` / `placements.id` UUIDs.
 * The legacy refs ("C1", "P1") are exposed as `.ref` for display/continuity.
 *
 * Dates are returned as ISO strings (serializable across the RSC boundary);
 * format them in the UI.
 */

type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];

type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

// Demo "now" — the seed anchors option expiries to this date (lib/db.ts TODAY).
// In production, swap this for `new Date()` so `dte` counts down live.
const DEMO_TODAY = new Date("2026-06-12T00:00:00Z");
const DAY_MS = 86_400_000;

function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Math.round((target - DEMO_TODAY.getTime()) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Security = {
  code: string;
  name: string;
  sector: string | null;
  listed: boolean;
  last: number | null;
  // Derivatives (options, instalment receipts) point at their ordinary ASX
  // code; `null` means this row IS the ordinary. See the trade-ledger migration.
  parent: string | null;
  securityClass: string | null; // 'Ordinary' | 'Options' | 'Allocation Interest'
};

// A client is now just the person/login. Account attributes (type, s708, cash)
// live on AccountRow — a client can own several accounts.
export type ClientRow = {
  id: string;
  ref: string | null;
  email: string | null;
  name: string;
  initials: string | null;
};

export type AccountRow = {
  id: string;
  ref: string | null;
  externalRef: string | null; // broker account number, e.g. '114716'
  clientId: string;
  label: string; // 'Personal', 'SMSF', …
  accountType: string;
  s708Expiry: string | null;
  cash: number;
  currency: string;
  adviserCode: string | null;
  adviserName: string | null;
  status: string | null; // broker account status, e.g. 'ACTIVE'
};

export type MergeRequestRow = {
  id: string;
  clientId: string;
  clientName: string; // resolved for staff display
  sourceAccountId: string | null;
  targetAccountId: string | null;
  sourceLabel: string;
  targetLabel: string;
  note: string | null;
  status: Enums<"merge_status">;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

/**
 * A client's claim over an existing account, by its broker account number.
 *
 * `accountNumber` is what the person typed (normalised). There is deliberately
 * no "does it exist" field: the request records the string and nothing else, so
 * that the form cannot be used to enumerate the firm's account numbers — see
 * supabase/migrations/20260904090000_account_claims.sql.
 */
export type ClaimRequestRow = {
  id: string;
  clientId: string;
  clientName: string; // resolved for staff display
  clientEmail: string | null; // the login the account would join
  accountNumber: string;
  note: string | null;
  status: Enums<"claim_status">;
  requestedAt: string;
  /** Set by an approval: the account that was actually moved. */
  matchedAccountId: string | null;
  /** Set by an approval: who held it before. */
  previousClientId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type Position = {
  accountId: string | null;
  clientId: string; // owning person (denormalized)
  code: string;
  parent: string; // rollup code — the ordinary ASX code, or `code` if it is one
  name: string;
  sector: string | null;
  qty: number;
  cost: number; // average cost per share
  last: number | null; // current price (from securities)
};

export type OptionRow = {
  id: string;
  ref: string | null;
  accountId: string | null;
  clientId: string; // owning person (denormalized)
  code: string;
  name: string;
  listed: boolean;
  type: Enums<"option_type">;
  qty: number;
  strike: number;
  under: number; // underlying price (from securities)
  dte: number; // days to expiry (from expiry_date, relative to DEMO_TODAY)
  expiryDate: string;
  source: string | null;
  status: Enums<"option_status">;
};

export type BidRow = {
  placementId: string;
  accountId: string | null;
  clientId: string;
  amount: number;
  alloc: number | null;
  paid: boolean;
};

export type PlacementRow = {
  id: string;
  ref: string | null;
  code: string;
  name: string;
  type: Enums<"placement_type">;
  price: number;
  last: number | null;
  disc: number | null;
  raise: number; // millions
  min: number;
  opts: string | null;
  stage: Enums<"placement_stage">;
  closeDate: string | null;
  allocDate: string | null;
  settleDate: string | null;
  allotDate: string | null;
  bids: BidRow[];
};

export type IndexRow = {
  code: string;
  name: string;
  last: number;
  chg: number;
  dp: number;
};

export type SignalRow = {
  code: string;
  action: Enums<"signal_action">;
  headline: string;
  detail: string | null;
  target: number | null;
};

export type SectorRow = {
  name: string;
  momentum: number;
  drivers: string | null;
  beneficiaries: string[];
};

export type NewsRow = {
  id: string;
  ts: string;
  source: string;
  headline: string;
  impact: string | null;
  direction: Enums<"news_direction">;
  use: string | null;
};

export type IdeaRow = {
  id: string;
  code: string;
  name: string;
  theme: string;
  risk: Enums<"risk_level">;
  horizon: string | null;
  conviction: number;
  last: number | null; // current price (from securities)
  entryLo: number | null;
  entryHi: number | null;
  target: number | null;
  hook: string | null;
  thesis: string | null;
  placementId: string | null;
};

export type WatchRow = {
  id: string;
  clientId: string;
  code: string | null;
  name: string;
  last: number | null;
  alert: number | null;
  dir: Enums<"alert_direction"> | null;
  unlisted: boolean;
};

export type RecoRow = {
  code: string;
  name: string;
  sector: string | null;
  rating: string;
  target: number | null;
  move: string | null;
};

export type ReportRow = {
  id: string;
  title: string;
  kind: string;
  published: string;
  pages: number | null;
};

export type NoteRow = {
  id: string;
  title: string;
  body: string;
  published: string;
};

export type AlertRow = {
  id: string;
  clientId: string | null;
  optionId: string | null;
  kind: Enums<"alert_kind">;
  sev: Enums<"alert_severity">;
  title: string;
  sub: string | null;
  ts: string;
  ack: boolean;
};

export type AuditRow = {
  id: number;
  ts: string;
  actor: string;
  role: string;
  action: string;
  detail: string | null;
  clientId: string | null;
};

/**
 * One contract-note line from the broker trade ledger. `value` is the NET cash
 * flow (BUY adds fees, SELL deducts them), which is why P&L math never has to
 * touch brokerage or GST separately.
 */
export type TradeRow = {
  id: string;
  cnote: string;
  accountId: string;
  clientId: string;
  code: string; // as traded, e.g. 'EOSXX'
  parent: string; // rollup code, e.g. 'EOS'
  name: string; // joined from securities
  instrument: string | null; // FPO | INSTPLAC | IPO | PLACEMENT…
  side: Enums<"trade_side">;
  tradeDate: string;
  units: number;
  avgPrice: number;
  consideration: number;
  brokerage: number;
  otherCharges: number;
  gst: number;
  value: number;
  adviser: string | null;
  status: string; // SETTLED | CANCELLED | REVERSAL | REVERSED
};

// ---------------------------------------------------------------------------
// Market master data
// ---------------------------------------------------------------------------
export const getSecurities = cache(async (): Promise<Security[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("securities")
    .select("*")
    .order("code");
  if (error) throw error;
  return data.map((r) => ({
    code: r.code,
    name: r.name,
    sector: r.sector,
    listed: r.listed,
    last: r.last_price,
    parent: r.parent_code,
    securityClass: r.security_class,
  }));
});

export const getSecurityMap = cache(async (): Promise<Map<string, Security>> => {
  const securities = await getSecurities();
  return new Map(securities.map((s) => [s.code, s]));
});

export const getMarketIndices = cache(async (): Promise<IndexRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("market_indices").select("*");
  if (error) throw error;
  return data.map((i) => ({
    code: i.code,
    name: i.name,
    last: i.last,
    chg: i.chg,
    dp: i.decimal_places,
  }));
});

// ---------------------------------------------------------------------------
// Clients & holdings
// ---------------------------------------------------------------------------
/**
 * Every client the firm has — excluding rows a claim has emptied.
 *
 * `merged_into` marks a broker-created client row whose last account moved to
 * another login (see `approve_account_claim`). The row is kept for the audit
 * trail and so the next import does not re-create it, but it owns nothing: left
 * in this list it would show up in the staff Clients table as a client with no
 * holdings, no P&L and no explanation, and in the client-view switcher as
 * somebody to inspect.
 */
export const getClients = cache(async (): Promise<ClientRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .is("merged_into", null)
    .order("ref");
  if (error) throw error;
  return data.map((c) => ({
    id: c.id,
    ref: c.ref,
    email: c.email,
    name: c.display_name,
    initials: c.initials,
  }));
});

export const getClient = cache(
  async (id: string): Promise<ClientRow | null> => {
    const clients = await getClients();
    return clients.find((c) => c.id === id) ?? null;
  },
);

// Investment accounts, optionally scoped to one client (owner).
export const getAccounts = cache(
  async (clientId?: string): Promise<AccountRow[]> => {
    const supabase = await createClient();
    // Imported broker accounts have no legacy `ref`, so fall back to the label
    // to keep the order stable rather than arbitrary.
    let query = supabase
      .from("accounts")
      .select("*")
      .order("ref", { nullsFirst: false })
      .order("label");
    if (clientId) query = query.eq("client_id", clientId);
    const { data, error } = await query;
    if (error) throw error;
    return data.map((a) => ({
      id: a.id,
      ref: a.ref,
      externalRef: a.external_ref,
      clientId: a.client_id,
      label: a.label,
      accountType: a.account_type,
      s708Expiry: a.s708_expiry,
      cash: a.cash_balance,
      currency: a.currency,
      adviserCode: a.adviser_code,
      adviserName: a.adviser_name,
      status: a.status,
    }));
  },
);

export const getAccount = cache(
  async (id: string): Promise<AccountRow | null> => {
    const accounts = await getAccounts();
    return accounts.find((a) => a.id === id) ?? null;
  },
);

// Account merge requests. RLS scopes clients to their own; staff see all. The
// client display name is joined in JS (getClients is likewise RLS-scoped).
export const getMergeRequests = cache(
  async (status?: Enums<"merge_status">): Promise<MergeRequestRow[]> => {
    const supabase = await createClient();
    let query = supabase
      .from("account_merge_requests")
      .select("*")
      .order("requested_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const [{ data, error }, clients] = await Promise.all([query, getClients()]);
    if (error) throw error;
    const nameById = new Map(clients.map((c) => [c.id, c.name]));
    return data.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientName: nameById.get(r.client_id) ?? "",
      sourceAccountId: r.source_account_id,
      targetAccountId: r.target_account_id,
      sourceLabel: r.source_label,
      targetLabel: r.target_label,
      note: r.note,
      status: r.status,
      requestedAt: r.requested_at,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
    }));
  },
);

/**
 * This week's note about one security, in both framings.
 *
 * Which one a client is shown depends on the sign of THEIR P&L on the holding,
 * which is the caller's business — the note itself is the same market read for
 * everybody, which is the point (see the 20260904100000 migration).
 */
export type SecurityCommentaryRow = {
  code: string;
  /** The Friday this note belongs to. */
  weekOf: string;
  lossNote: string;
  profitNote: string;
  sources: { title: string; url: string }[];
  /** A desk member's name where the note was written or corrected by hand. */
  editedBy: string | null;
};

/**
 * The most recent weekly commentary, one row per security.
 *
 * ── Why the newest week per security, and not "this week" ───────────────────
 * Asking for `commentaryWeek(now)` would blank the whole feature between the
 * Friday close and whenever the batch finishes — and blank it permanently for
 * any security whose note failed validation that week. A note is captioned with
 * its own date on screen, so serving last week's is honest and useful where
 * serving nothing is neither.
 *
 * Rows arrive newest-first and the first one per code wins, which is the
 * newest. Done in JS rather than as a lateral join because PostgREST has no way
 * to express "latest row per group" and the table is small: one row per held
 * security per week, so ~142 a week.
 */
export const getSecurityCommentary = cache(
  async (): Promise<Map<string, SecurityCommentaryRow>> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("security_commentary")
      .select("*")
      .order("week_of", { ascending: false })
      // Twelve weeks of a fully covered book. Bounded because this is a read on
      // every portfolio page load and an unbounded one grows without limit.
      .limit(2000);

    // A missing table (the migration has not been applied yet) must not take
    // the portfolio page down with it — the commentary is an addition to that
    // screen, not a prerequisite for it.
    if (error) {
      console.warn(`security_commentary unavailable: ${error.message}`);
      return new Map();
    }

    const latest = new Map<string, SecurityCommentaryRow>();
    for (const r of data) {
      if (latest.has(r.security_code)) continue; // newest-first, so this is older
      latest.set(r.security_code, {
        code: r.security_code,
        weekOf: r.week_of,
        lossNote: r.loss_note,
        profitNote: r.profit_note,
        sources: Array.isArray(r.sources)
          ? (r.sources as { title: string; url: string }[])
          : [],
        editedBy: r.edited_by,
      });
    }
    return latest;
  },
);

/**
 * Account claims. RLS scopes a client to their own; staff see all.
 *
 * `clientId` narrows it further for the client's own page, which asks for its
 * own rows explicitly rather than relying on RLS alone — belt and braces, and
 * it also means a staff member inspecting a client sees that client's claims
 * rather than the whole firm's.
 */
export const getAccountClaims = cache(
  async (clientId?: string): Promise<ClaimRequestRow[]> => {
    const supabase = await createClient();
    let query = supabase
      .from("account_claim_requests")
      .select("*")
      .order("requested_at", { ascending: false });
    if (clientId) query = query.eq("client_id", clientId);
    const [{ data, error }, clients] = await Promise.all([query, getClients()]);
    if (error) throw error;
    const byId = new Map(clients.map((c) => [c.id, c]));
    return data.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientName: byId.get(r.client_id)?.name ?? "",
      clientEmail: byId.get(r.client_id)?.email ?? null,
      accountNumber: r.account_number,
      note: r.note,
      status: r.status,
      requestedAt: r.requested_at,
      matchedAccountId: r.matched_account_id,
      previousClientId: r.previous_client_id,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
    }));
  },
);

// Shared row mappers so account- and client-scoped getters return the same shape.
function toPosition(
  p: Tables<"positions">,
  securityMap: Map<
    string,
    { name: string; sector: string | null; last: number | null; parent: string | null }
  >,
): Position {
  const sec = securityMap.get(p.security_code);
  // A derivative rolls up to its ordinary; an ordinary is its own parent.
  const parent = sec?.parent ?? p.security_code;
  return {
    accountId: p.account_id,
    clientId: p.client_id,
    code: p.security_code,
    parent,
    name: sec?.name ?? p.security_code,
    /**
     * The ORDINARY's sector where the row is a derivative.
     *
     * An option series has no sector of its own — no data source classifies
     * `ABXO`, only `ABX` — so reading it off the row's own code left every
     * option unclassified and dropped it into "Other". The exposure a client
     * has through a grant is exposure to the underlying's sector, which is the
     * question a sector breakdown is asking.
     */
    sector: sec?.sector ?? securityMap.get(parent)?.sector ?? null,
    qty: p.qty,
    cost: p.avg_cost,
    last: sec?.last ?? null,
  };
}

function toOption(
  o: Tables<"option_holdings">,
  securityMap: Map<string, { last: number | null }>,
): OptionRow {
  return {
    id: o.id,
    ref: o.ref,
    accountId: o.account_id,
    clientId: o.client_id,
    code: o.code,
    name: o.name,
    listed: o.listed,
    type: o.option_type,
    qty: o.qty,
    strike: o.strike,
    under: o.underlying_code
      ? (securityMap.get(o.underlying_code)?.last ?? 0)
      : 0,
    dte: daysUntil(o.expiry_date),
    expiryDate: o.expiry_date,
    source: o.source,
    status: o.status,
  };
}

// Account-scoped (client portal shows one account at a time).
//
// An EMPTY id means "this client has no account", which `getActiveAccountId()`
// returns for a newly registered client whose first account claim is still with
// the desk. It is answered here with no rows rather than passed to PostgREST:
// `account_id=eq.` makes Postgres cast '' to uuid, which fails as 22P02 and
// surfaces as a 500 on the client dashboard. "No account" is a legitimate state
// with an obvious answer, not a query error.
export const getPositions = cache(
  async (accountId: string): Promise<Position[]> => {
    if (!accountId) return [];
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase.from("positions").select("*").eq("account_id", accountId),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return data.map((p) => toPosition(p, securityMap));
  },
);

export const getOptions = cache(
  async (accountId: string): Promise<OptionRow[]> => {
    if (!accountId) return [];   // see getPositions
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase
        .from("option_holdings")
        .select("*")
        .eq("account_id", accountId)
        .order("ref"),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return data.map((o) => toOption(o, securityMap));
  },
);

// Client-scoped aggregation across all of a client's accounts (staff views).
export const getClientPositions = cache(
  async (clientId: string): Promise<Position[]> => {
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase.from("positions").select("*").eq("client_id", clientId),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return data.map((p) => toPosition(p, securityMap));
  },
);

export const getClientOptions = cache(
  async (clientId: string): Promise<OptionRow[]> => {
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase
        .from("option_holdings")
        .select("*")
        .eq("client_id", clientId)
        .order("ref"),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return data.map((o) => toOption(o, securityMap));
  },
);

export const getAllOptions = cache(
  async (): Promise<OptionRow[]> => {
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase
        .from("option_holdings")
        .select("*")
        .order("ref"),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return (data ?? []).map((o) => toOption(o, securityMap));
  },
);

interface TradeDbRow {
  id: string;
  cnote: string;
  account_id: string;
  client_id: string;
  security_code: string;
  parent_code: string;
  instrument: string;
  side: "BUY" | "SELL";
  trade_date: string;
  settle_date?: string;
  units: number;
  price?: number;
  avg_price?: number;
  consideration: number;
  brokerage: number;
  other_charges?: number;
  gst: number;
  value?: number;
  adviser?: string | null;
  total_cost?: number;
  status: string;
  contract_url?: string | null;
  trade_time?: string | null;
}

/**
 * A client's full contract-note history, newest first, across all of their
 * accounts. Non-settled rows (CANCELLED / REVERSAL / REVERSED) are included
 * deliberately — they never reach P&L, but omitting them from the order history
 * would hide contract notes the broker actually issued.
 */
export const getClientTrades = cache(
  async (clientId: string): Promise<TradeRow[]> => {
    const supabase = await createClient();
    // Paged: one real client holds 1,650 contract notes, and PostgREST would
    // hand back the first 1,000 without a word — silently truncating their
    // order history, their realised-P&L chart and every total on the page.
    const [data, securityMap] = await Promise.all([
      pagedSelect<TradeDbRow>(supabase, "trades", "*", (b) =>
        b
          .eq("client_id", clientId)
          .order("trade_date", { ascending: false })
          .order("cnote", { ascending: false }),
      ),
      getSecurityMap(),
    ]);

    return data.map((t) => ({
      id: t.id,
      cnote: t.cnote,
      accountId: t.account_id,
      clientId: t.client_id,
      code: t.security_code,
      parent: t.parent_code,
      name: securityMap.get(t.security_code)?.name ?? t.security_code,
      instrument: t.instrument,
      side: t.side,
      tradeDate: t.trade_date,
      units: t.units,
      avgPrice: t.avg_price ?? t.price ?? 0,
      consideration: t.consideration,
      brokerage: t.brokerage,
      otherCharges: t.other_charges ?? 0,
      gst: t.gst,
      value: t.value ?? t.consideration ?? 0,
      adviser: t.adviser ?? null,
      status: t.status,
    }));
  },
);

// ---------------------------------------------------------------------------
// Placements & bids
// ---------------------------------------------------------------------------
export const getPlacements = cache(async (): Promise<PlacementRow[]> => {
  const supabase = await createClient();
  const [placementsRes, bidsRes] = await Promise.all([
    supabase.from("placements").select("*").order("ref"),
    supabase.from("bids").select("*"),
  ]);
  if (placementsRes.error) throw placementsRes.error;
  if (bidsRes.error) throw bidsRes.error;

  const bidsByPlacement = new Map<string, BidRow[]>();
  for (const b of bidsRes.data ?? []) {
    const list = bidsByPlacement.get(b.placement_id) ?? [];
    list.push({
      placementId: b.placement_id,
      accountId: b.account_id,
      clientId: b.client_id,
      amount: b.amount,
      alloc: b.alloc,
      paid: b.paid,
    });
    bidsByPlacement.set(b.placement_id, list);
  }

  return placementsRes.data.map((p) => ({
    id: p.id,
    ref: p.ref,
    code: p.code,
    name: p.name,
    type: p.type,
    price: p.price,
    last: p.last,
    disc: p.discount_pct,
    raise: p.raise_millions,
    min: p.min_bid,
    opts: p.opts,
    stage: p.stage,
    closeDate: p.close_date,
    allocDate: p.alloc_date,
    settleDate: p.settle_date,
    allotDate: p.allot_date,
    bids: bidsByPlacement.get(p.id) ?? [],
  }));
});

// ---------------------------------------------------------------------------
// Watchlists & alerts
// ---------------------------------------------------------------------------
export const getWatchlist = cache(
  async (clientId: string): Promise<WatchRow[]> => {
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase.from("watchlist_items").select("*").eq("client_id", clientId),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return data.map((w) => ({
      id: w.id,
      clientId: w.client_id,
      code: w.security_code,
      name: w.display_name,
      last: w.security_code
        ? (securityMap.get(w.security_code)?.last ?? null)
        : null,
      alert: w.alert_threshold,
      dir: w.alert_direction,
      unlisted: w.unlisted,
    }));
  },
);

/**
 * Alerts are derived (populated by the alert engine, not seeded) — this returns
 * whatever the engine has written. `clientId` null returns firm-wide alerts.
 */
export const getAlerts = cache(
  async (clientId?: string): Promise<AlertRow[]> => {
    const supabase = await createClient();
    let query = supabase
      .from("alerts")
      .select("*")
      .order("triggered_at", { ascending: false });
    if (clientId) query = query.eq("client_id", clientId);
    const { data, error } = await query;
    if (error) throw error;
    return data.map((a) => ({
      id: a.id,
      clientId: a.client_id,
      optionId: a.option_id,
      kind: a.kind,
      sev: a.severity,
      title: a.title,
      sub: a.subtitle,
      ts: a.triggered_at,
      ack: a.acknowledged,
    }));
  },
);

// ---------------------------------------------------------------------------
// Research / content
// ---------------------------------------------------------------------------
export const getSignals = cache(async (): Promise<SignalRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("signals").select("*");
  if (error) throw error;
  return data.map((s) => ({
    code: s.security_code,
    action: s.action,
    headline: s.headline,
    detail: s.detail,
    target: s.target,
  }));
});

export const getSectors = cache(async (): Promise<SectorRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sectors")
    .select("*")
    .order("momentum", { ascending: false });
  if (error) throw error;
  return data.map((s) => ({
    name: s.name,
    momentum: s.momentum,
    drivers: s.drivers,
    beneficiaries: s.beneficiaries ?? [],
  }));
});

export const getNews = cache(async (): Promise<NewsRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("news")
    .select("*")
    .order("ts", { ascending: false });
  if (error) throw error;
  return data.map((n) => ({
    id: n.id,
    ts: n.ts,
    source: n.source,
    headline: n.headline,
    impact: n.impact,
    direction: n.direction,
    use: n.use_note,
  }));
});

export const getInvestmentIdeas = cache(async (): Promise<IdeaRow[]> => {
  const supabase = await createClient();
  const [{ data, error }, securityMap] = await Promise.all([
    supabase.from("investment_ideas").select("*"),
    getSecurityMap(),
  ]);
  if (error) throw error;
  return data.map((i) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    theme: i.theme,
    risk: i.risk,
    horizon: i.horizon,
    conviction: i.conviction,
    last: securityMap.get(i.code)?.last ?? null,
    entryLo: i.entry_lo,
    entryHi: i.entry_hi,
    target: i.target,
    hook: i.hook,
    thesis: i.thesis,
    placementId: i.placement_id,
  }));
});

export const getRecommendations = cache(async (): Promise<RecoRow[]> => {
  const supabase = await createClient();
  const [{ data, error }, securityMap] = await Promise.all([
    supabase.from("recommendations").select("*"),
    getSecurityMap(),
  ]);
  if (error) throw error;
  return data.map((r) => {
    const sec = securityMap.get(r.security_code);
    return {
      code: r.security_code,
      name: sec?.name ?? r.security_code,
      sector: sec?.sector ?? null,
      rating: r.rating,
      target: r.target_price,
      move: r.move,
    };
  });
});

export const getResearchReports = cache(async (): Promise<ReportRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("research_reports")
    .select("*")
    .order("published", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    published: r.published,
    pages: r.pages,
  }));
});

export const getResearchNotes = cache(async (): Promise<NoteRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("research_notes")
    .select("*")
    .order("published", { ascending: false });
  if (error) throw error;
  return data.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    published: n.published,
  }));
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
export const getAuditLog = cache(async (limit = 50): Promise<AuditRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .order("ts", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.map((a) => ({
    id: a.id,
    ts: a.ts,
    actor: a.actor,
    role: a.role,
    action: a.action,
    detail: a.detail,
    clientId: a.client_id,
  }));
});
