import "server-only";
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
};

export type ClientRow = {
  id: string;
  ref: string | null;
  email: string | null;
  name: string;
  initials: string | null;
  accountType: string;
  s708Expiry: string | null;
  cash: number;
  currency: string;
};

export type Position = {
  clientId: string;
  code: string;
  name: string;
  sector: string | null;
  qty: number;
  cost: number; // average cost per share
  last: number | null; // current price (from securities)
};

export type OptionRow = {
  id: string;
  ref: string | null;
  clientId: string;
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
  }));
});

const getSecurityMap = cache(async (): Promise<Map<string, Security>> => {
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
export const getClients = cache(async (): Promise<ClientRow[]> => {
  const supabase = await createClient();
  const [clientsRes, accountsRes] = await Promise.all([
    supabase.from("clients").select("*").order("ref"),
    supabase.from("client_accounts").select("*"),
  ]);
  if (clientsRes.error) throw clientsRes.error;
  if (accountsRes.error) throw accountsRes.error;

  const accountByClient = new Map(
    (accountsRes.data ?? []).map((a) => [a.client_id, a]),
  );

  return clientsRes.data.map((c) => {
    const account = accountByClient.get(c.id);
    return {
      id: c.id,
      ref: c.ref,
      email: c.email,
      name: c.display_name,
      initials: c.initials,
      accountType: c.account_type,
      s708Expiry: c.s708_expiry,
      cash: account?.cash_balance ?? 0,
      currency: account?.currency ?? "AUD",
    };
  });
});

export const getClient = cache(
  async (id: string): Promise<ClientRow | null> => {
    const clients = await getClients();
    return clients.find((c) => c.id === id) ?? null;
  },
);

export const getPositions = cache(
  async (clientId: string): Promise<Position[]> => {
    const supabase = await createClient();
    const [{ data, error }, securityMap] = await Promise.all([
      supabase.from("positions").select("*").eq("client_id", clientId),
      getSecurityMap(),
    ]);
    if (error) throw error;
    return data.map((p) => {
      const sec = securityMap.get(p.security_code);
      return {
        clientId: p.client_id,
        code: p.security_code,
        name: sec?.name ?? p.security_code,
        sector: sec?.sector ?? null,
        qty: p.qty,
        cost: p.avg_cost,
        last: sec?.last ?? null,
      };
    });
  },
);

export const getOptions = cache(
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
    return data.map((o) => ({
      id: o.id,
      ref: o.ref,
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
