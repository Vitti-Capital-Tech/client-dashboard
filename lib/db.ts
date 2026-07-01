export interface Client {
  id: string;
  name: string;
  av: string;
  type: string;
  s708: string;
}

export interface Position {
  c: string; // client id
  code: string;
  name: string;
  qty: number;
  cost: number;
  last: number;
  sector: string;
}

export interface OptionHolding {
  id: string;
  c: string; // client id
  code: string;
  name: string;
  listed: boolean;
  type: "Call" | "Put";
  qty: number;
  strike: number;
  under: number;
  dte: number; // days to expiry
  source: string;
  status: "open" | "pending" | "expired";
}

export interface Bid {
  c: string; // client id
  amount: number;
  alloc: number | null;
  _paid?: boolean;
}

export interface Placement {
  id: string;
  code: string;
  name: string;
  type: string;
  price: number;
  last: number | null;
  disc: number | null; // discount percentage
  raise: number; // in millions
  min: number;
  opts: string; // options attachment
  stage: "open" | "closed" | "upcoming" | "settled";
  closeDate: Date;
  allocDate: Date;
  settleDate: Date;
  allotDate: Date;
  bids: Bid[];
}

export interface IndexData {
  code: string;
  name: string;
  last: number;
  chg: number;
  dp?: number;
}

export interface Signal {
  action: "Add" | "Hold" | "Trim" | "Take profit" | "Watch";
  headline: string;
  detail: string;
  target: number | null;
}

export interface Sector {
  name: string;
  mom: number;
  drivers: string;
  benef: string[];
}

export interface News {
  time: string;
  src: string;
  head: string;
  impact: string;
  dir: "up" | "dn";
  use: string;
}

export interface Goal {
  k: string;
  label: string;
  icon: string;
  themes: string[];
  blurb: string;
}

export interface InvestmentIdea {
  code: string;
  name: string;
  theme: string;
  risk: "Low" | "Medium" | "High";
  horizon: string;
  conv: number; // conviction rating 1-3
  last: number | null;
  entryLo: number | null;
  entryHi: number | null;
  target: number | null;
  hook: string;
  thesis: string;
  deal?: string;
}

export interface WatchItem {
  code: string;
  name: string;
  last: number | null;
  chg: number;
  alert: number | null;
  dir?: "above" | "below";
  unl?: boolean;
}

export interface Alert {
  id: string;
  client: string | null;
  optId: string | null;
  kind: "expiry" | "itm" | "window" | "price";
  sev: "red" | "amber" | "green";
  title: string;
  sub: string;
  ts: Date;
  ack: boolean;
}

export interface AuditEntry {
  ts: Date;
  user: string;
  role: string;
  action: string;
  detail: string;
}

export interface ResearchNote {
  title: string;
  time: string;
  body: string;
}

export interface ResearchReport {
  title: string;
  kind: string;
  date: Date;
  pp: number;
}

export interface Database {
  clients: Record<string, Client>;
  positions: Position[];
  options: OptionHolding[];
  placements: Placement[];
  indices: IndexData[];
  note: ResearchNote;
  recos: { code: string; name: string; rating: string; tp: number | null; move: string; sect: string }[];
  reports: ResearchReport[];
  signals: Record<string, Signal>;
  sectors: Sector[];
  news: News[];
  themes: string[];
  goals: Goal[];
  ideas: InvestmentIdea[];
  watch: Record<string, WatchItem[]>;
  alerts: Alert[];
  audit: AuditEntry[];
}

export const TODAY = new Date(2026, 5, 12);

export function addDays(d: Date, n: number): Date {
  const newDate = new Date(d);
  newDate.setDate(newDate.getDate() + n);
  return newDate;
}

export const INITIAL_DATABASE: Database = {
  clients: {
    C1: { id: "C1", name: "James Halloran", av: "JH", type: "Individual · wholesale", s708: "Mar 2027" },
    C2: { id: "C2", name: "Margaret Chen", av: "MC", type: "Individual · wholesale", s708: "Aug 2026" },
    C3: { id: "C3", name: "Endeavour Family Office", av: "EF", type: "Family office", s708: "Jan 2028" },
    C4: { id: "C4", name: "David Okafor", av: "DO", type: "SMSF · wholesale", s708: "Nov 2026" },
  },
  positions: [
    { c: "C1", code: "BHP", name: "BHP Group", qty: 2100, cost: 38.40, last: 44.18, sector: "Materials" },
    { c: "C1", code: "CSL", name: "CSL Limited", qty: 240, cost: 285.00, last: 299.30, sector: "Health care" },
    { c: "C1", code: "PLS", name: "Pilbara Minerals", qty: 21400, cost: 3.10, last: 3.84, sector: "Materials" },
    { c: "C1", code: "WES", name: "Wesfarmers", qty: 1050, cost: 64.20, last: 78.92, sector: "Consumer" },
    { c: "C2", code: "CBA", name: "Commonwealth Bank", qty: 600, cost: 104.10, last: 132.40, sector: "Financials" },
    { c: "C2", code: "BHP", name: "BHP Group", qty: 1400, cost: 41.10, last: 44.18, sector: "Materials" },
    { c: "C2", code: "WDS", name: "Woodside Energy", qty: 2200, cost: 29.60, last: 26.40, sector: "Energy" },
    { c: "C3", code: "BHP", name: "BHP Group", qty: 8200, cost: 36.90, last: 44.18, sector: "Materials" },
    { c: "C3", code: "CSL", name: "CSL Limited", qty: 1100, cost: 270.40, last: 299.30, sector: "Health care" },
    { c: "C3", code: "MQG", name: "Macquarie Group", qty: 900, cost: 178.20, last: 214.50, sector: "Financials" },
    { c: "C3", code: "PLS", name: "Pilbara Minerals", qty: 60000, cost: 3.55, last: 3.84, sector: "Materials" },
    { c: "C4", code: "FMG", name: "Fortescue", qty: 3400, cost: 24.80, last: 22.41, sector: "Materials" },
    { c: "C4", code: "CBA", name: "Commonwealth Bank", qty: 300, cost: 98.00, last: 132.40, sector: "Financials" },
  ],
  options: [
    { id: "O1", c: "C1", code: "VEXO", name: "Vertex Gold options", listed: true, type: "Call", qty: 15000, strike: 0.45, under: 0.52, dte: 202, source: "SPP Apr 26", status: "open" },
    { id: "O2", c: "C1", code: "MRDO", name: "Meridian Resources options", listed: false, type: "Call", qty: 0, strike: 0.75, under: 0.59, dte: 735, source: "Placement attaching", status: "pending" },
    { id: "O3", c: "C1", code: "HLXO", name: "Helios Energy options", listed: false, type: "Call", qty: 30000, strike: 2.50, under: 2.00, dte: 657, source: "Series B sweetener", status: "open" },
    { id: "O4", c: "C2", code: "NVXO", name: "Novonix options", listed: true, type: "Call", qty: 40000, strike: 0.80, under: 0.91, dte: 5, source: "Rights issue", status: "open" },
    { id: "O5", c: "C2", code: "ZPCO", name: "Zip Co options", listed: true, type: "Call", qty: 12000, strike: 1.40, under: 1.28, dte: 27, source: "Listed market", status: "open" },
    { id: "O6", c: "C3", code: "AURO", name: "Aurora Biotech options", listed: false, type: "Call", qty: 50000, strike: 1.00, under: 1.20, dte: 3, source: "Pre-IPO note", status: "open" },
    { id: "O7", c: "C3", code: "LTRO", name: "Liontown options", listed: true, type: "Call", qty: 25000, strike: 1.20, under: 1.06, dte: 88, source: "Listed market", status: "open" },
    { id: "O8", c: "C4", code: "CXOO", name: "Core Lithium options", listed: false, type: "Call", qty: 80000, strike: 0.15, under: 0.18, dte: 1, source: "Placement attaching", status: "open" },
    { id: "O9", c: "C4", code: "BRNO", name: "Brainchip options", listed: true, type: "Call", qty: 30000, strike: 0.30, under: 0.24, dte: 14, source: "Listed market", status: "open" },
    { id: "O10", c: "C1", code: "TLXO", name: "Telix options (expired)", listed: true, type: "Call", qty: 10000, strike: 18.00, under: 14.20, dte: -9, source: "Listed market", status: "expired" },
  ],
  placements: [
    {
      id: "P1",
      code: "MRD",
      name: "Meridian Resources",
      type: "Placement",
      price: 0.50,
      last: 0.59,
      disc: 15.3,
      raise: 12.0,
      min: 10000,
      opts: "1 free option (1:2)",
      stage: "open",
      closeDate: TODAY,
      allocDate: addDays(TODAY, 3),
      settleDate: addDays(TODAY, 6),
      allotDate: addDays(TODAY, 7),
      bids: [
        { c: "C2", amount: 60000, alloc: null },
        { c: "C3", amount: 150000, alloc: null },
      ],
    },
    {
      id: "P2",
      code: "TTM",
      name: "Tectonic Metals",
      type: "Placement",
      price: 0.50,
      last: 0.51,
      disc: 12.0,
      raise: 8.0,
      min: 10000,
      opts: "None",
      stage: "closed",
      closeDate: addDays(TODAY, -1),
      allocDate: TODAY,
      settleDate: addDays(TODAY, 4),
      allotDate: addDays(TODAY, 5),
      bids: [
        { c: "C1", amount: 40000, alloc: null },
        { c: "C2", amount: 25000, alloc: null },
        { c: "C3", amount: 80000, alloc: null },
        { c: "C4", amount: 30000, alloc: null },
      ],
    },
    {
      id: "P3",
      code: "AUR",
      name: "Aurora Biotech",
      type: "Pre-IPO",
      price: 1.20,
      last: null,
      disc: null,
      raise: 25.0,
      min: 25000,
      opts: "1 free option (1:1)",
      stage: "upcoming",
      closeDate: addDays(TODAY, 5),
      allocDate: addDays(TODAY, 8),
      settleDate: addDays(TODAY, 11),
      allotDate: addDays(TODAY, 12),
      bids: [],
    },
    {
      id: "P4",
      code: "VEX",
      name: "Vertex Gold",
      type: "SPP",
      price: 0.42,
      last: 0.51,
      disc: 17.6,
      raise: 3.0,
      min: 5000,
      opts: "1 free option (1:3)",
      stage: "settled",
      closeDate: addDays(TODAY, -40),
      allocDate: addDays(TODAY, -38),
      settleDate: addDays(TODAY, -35),
      allotDate: addDays(TODAY, -34),
      bids: [
        { c: "C1", amount: 15000, alloc: 15000, _paid: true },
        { c: "C3", amount: 20000, alloc: 20000, _paid: true },
      ],
    },
  ],
  indices: [
    { code: "XJO", name: "S&P/ASX 200", last: 8412.3, chg: 0.61 },
    { code: "XKO", name: "ASX 300", last: 8327.1, chg: 0.58 },
    { code: "XSO", name: "Small Ords", last: 3261.8, chg: 0.92 },
    { code: "AUDUSD", name: "AUD / USD", last: 0.6712, chg: -0.12, dp: 4 },
    { code: "XAU", name: "Gold (USD/oz)", last: 2418.0, chg: 0.40, dp: 0 },
    { code: "BRENT", name: "Brent crude", last: 81.22, chg: -1.10 },
  ],
  note: {
    title: "RBA holds at 3.85%; miners firm on China stimulus",
    time: "7:42am",
    body: "Futures point the XJO up 0.4% at the open after the RBA left rates on hold and Chinese stimulus lifted iron ore. Lithium names are in focus ahead of the MRD book close at 4:00pm. We stay constructive on quality materials and selectively on pre-IPO resources exposure.",
  },
  recos: [
    { code: "MRD", name: "Meridian Resources", rating: "Spec buy", tp: 0.78, move: "+3.5%", sect: "Materials" },
    { code: "BHP", name: "BHP Group", rating: "Buy", tp: 49.50, move: "+0.8%", sect: "Materials" },
    { code: "CSL", name: "CSL Limited", rating: "Hold", tp: 305.00, move: "-0.4%", sect: "Health care" },
    { code: "AUR", name: "Aurora Biotech", rating: "Spec buy", tp: null, move: "pre-IPO", sect: "Health care" },
    { code: "MQG", name: "Macquarie Group", rating: "Buy", tp: 228.00, move: "+1.1%", sect: "Financials" },
  ],
  reports: [
    { title: "Lithium — supply deficit widens into 2027", kind: "Sector note", date: addDays(TODAY, -1), pp: 12 },
    { title: "MRD initiation — drilling the Pilbara’s quiet corner", kind: "Company note", date: addDays(TODAY, -3), pp: 18 },
    { title: "Mid-year strategy — positioning for a lower-rate world", kind: "Strategy", date: addDays(TODAY, -6), pp: 24 },
  ],
  signals: {
    BHP: { action: "Add", headline: "Iron ore firm on China stimulus; copper optionality building", detail: "Trading inside our entry band with near-term support from Chinese stimulus and a structural copper bid from electrification. We’d add on any weakness toward $42.", target: 49.50 },
    CSL: { action: "Add", headline: "Plasma margins recovering into an undemanding valuation", detail: "Collection costs are normalising and immunoglobulin demand is durable. The de-rating has gone too far for the quality; we see re-rating room toward $330.", target: 330.00 },
    PLS: { action: "Hold", headline: "Lithium leverage — wait for confirmation above $3.90", detail: "Low-cost spodumene leaves PLS well placed for the next up-cycle, but the price is volatile. Hold existing exposure; add only on a confirmed break of the entry ceiling.", target: 4.80 },
    WES: { action: "Hold", headline: "Quality compounder — let it run toward target", detail: "Bunnings keeps taking share and capital allocation is disciplined. Core income holding; no action needed below $88.", target: 88.00 },
    WDS: { action: "Trim", headline: "Energy soft — rotate into higher-conviction names", detail: "Oil is under pressure on demand worries and a gas glut. We’d lighten energy here and redeploy toward materials or financials.", target: null },
    CBA: { action: "Take profit", headline: "Above our fair value — consider trimming", detail: "CBA trades richly versus the sector on most metrics. Banking the gain and rotating to MQG offers better risk/reward.", target: null },
    MQG: { action: "Add", headline: "Fee momentum rebuilding; sits below our target", detail: "Annuity-style asset management plus a recovery in deal activity and green infrastructure should rebuild performance fees. Attractive below $218.", target: 228.00 },
    FMG: { action: "Watch", headline: "Pure iron-ore leverage — wait for entry near $21", detail: "High-beta to the iron ore price with a generous but cyclical yield. We’d wait for a better entry rather than chase here.", target: null },
  },
  sectors: [
    { name: "Resources & materials", mom: 4.2, drivers: "China stimulus + structural lithium and copper deficits", benef: ["BHP", "PLS", "FMG"] },
    { name: "Technology & AI", mom: 3.4, drivers: "AI data-centre capex cycle lifting compute and power demand", benef: [] },
    { name: "Financials", mom: 1.1, drivers: "Rate plateau, buybacks and rebuilding deal flow", benef: ["CBA", "MQG"] },
    { name: "Health care", mom: 0.6, drivers: "Defensive bid and plasma-margin recovery", benef: ["CSL"] },
    { name: "Energy", mom: -1.8, drivers: "Soft oil demand and ample gas supply", benef: ["WDS"] },
  ],
  news: [
    { time: "6:40am", src: "Beijing", head: "China unveils fresh stimulus targeting property and infrastructure", impact: "Materials ↑", dir: "up", use: "Direct tailwind for iron ore and base metals — supports BHP and PLS. Consider adding materials on dips rather than chasing strength." },
    { time: "5:10am", src: "Washington", head: "US CPI comes in cooler than expected; rate-cut odds rise", impact: "Rates ↓ · Growth ↑", dir: "up", use: "A lower-for-longer path supports growth equities and gold. Constructive for MQG and resources; a reason to deploy idle cash steadily." },
    { time: "Yesterday", src: "Global", head: "Brent slides below $82 on demand concerns", impact: "Energy ↓", dir: "dn", use: "Headwind for energy names — we’d trim WDS and rotate the proceeds into higher-conviction materials or financials." },
    { time: "Yesterday", src: "US", head: "Hyperscalers lift AI data-centre capex guidance again", impact: "Tech / Copper ↑", dir: "up", use: "Reinforces the copper demand story (BHP) and a structural AI theme that most Australian portfolios under-own — worth a strategic position." },
  ],
  themes: ["Blue chips", "Resources", "Pre-IPO & deals", "Income"],
  goals: [
    { k: "grow", label: "Grow my money", icon: "M4 19V5M4 19h16M8 15l3-4 3 2 4-6", themes: ["Resources", "Blue chips"], blurb: "Growth-focused ideas with more upside (and more movement)." },
    { k: "income", label: "Earn income", icon: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6", themes: ["Income"], blurb: "Established companies that pay regular dividends." },
    { k: "early", label: "Get in early", icon: "M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z", themes: ["Pre-IPO & deals"], blurb: "Placements and pre-IPO deals — Vitti’s edge, higher risk." },
    { k: "steady", label: "Keep it steady", icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", themes: ["Blue chips", "Income"], blurb: "Larger, lower-volatility names to build a base." },
  ],
  ideas: [
    { code: "BHP", name: "BHP Group", theme: "Blue chips", risk: "Low", horizon: "12 months", conv: 3, last: 44.18, entryLo: 42.00, entryHi: 45.50, target: 49.50, hook: "The world’s biggest miner, at a fair price", thesis: "BHP pairs low-cost iron ore with growing copper exposure as electrification demand builds. A strong balance sheet funds a reliable dividend while the company invests through the cycle. Recent China stimulus supports near-term prices. We see a steady re-rate toward our target with limited downside for a portfolio anchor." },
    { code: "WES", name: "Wesfarmers", theme: "Income", risk: "Low", horizon: "12–18 months", conv: 3, last: 78.92, entryLo: 70.00, entryHi: 80.00, target: 88.00, hook: "Bunnings-led quality compounder with a steady yield", thesis: "Wesfarmers owns category-leading retail (Bunnings, Kmart) that keeps taking share, plus optionality in lithium and healthcare. Defensive earnings and disciplined capital allocation support a dependable, growing dividend. We like it as a core income holding that still offers capital growth over time." },
    { code: "MQG", name: "Macquarie Group", theme: "Income", risk: "Medium", horizon: "12 months", conv: 2, last: 214.50, entryLo: 205.00, entryHi: 218.00, target: 228.00, hook: "Global franchise with rising asset-management fees", thesis: "Macquarie blends annuity-style asset management with leverage to a recovery in deal activity and green infrastructure. The dividend is solid and partially franked. As markets normalise, performance fees and advisory income should rebuild, supporting both the payout and the share price." },
    { code: "PLS", name: "Pilbara Minerals", theme: "Resources", risk: "High", horizon: "18–24 months", conv: 2, last: 3.84, entryLo: 3.50, entryHi: 3.90, target: 4.80, hook: "Lowest-cost lithium leverage to the next up-cycle", thesis: "Pilbara is a low-cost, tier-one spodumene producer expanding capacity into a structural lithium deficit forming from 2027. The price is volatile and tied to the lithium cycle, so size it as a satellite. For investors who want direct exposure to the energy-transition theme, this is our preferred name." },
    { code: "MRD", name: "Meridian Resources", theme: "Pre-IPO & deals", risk: "High", horizon: "2–3 years", conv: 2, last: 0.59, entryLo: 0.50, entryHi: 0.60, target: 0.78, deal: "P1", hook: "Live placement — buy in at a 15% discount today", thesis: "Meridian is drilling a promising, under-explored corner of the Pilbara. A live placement lets you buy at $0.50, a 15% discount to market, with a free attaching option for extra upside. Speculative and pre-revenue, so size small, but the risk/reward on a discovery is compelling." },
    { code: "AUR", name: "Aurora Biotech", theme: "Pre-IPO & deals", risk: "High", horizon: "3+ years", conv: 2, last: null, entryLo: null, entryHi: null, target: null, deal: "P3", hook: "Pre-IPO access before it lists", thesis: "Aurora is a clinical-stage biotech approaching a planned ASX listing. Our pre-IPO allocation lets wholesale clients invest at $1.20 before public markets. Binary on trial outcomes and illiquid until listing, so this is for risk-tolerant capital seeking asymmetric, early-stage upside." },
    { code: "CSL", name: "CSL Limited", theme: "Blue chips", risk: "Low", horizon: "18 months", conv: 3, last: 299.30, entryLo: 285.00, entryHi: 305.00, target: 330.00, hook: "World-class healthcare compounder on sale", thesis: "CSL is a global leader in blood plasma therapies and vaccines with durable demand and widening margins as collection costs normalise. After a period of underperformance the valuation is undemanding for the quality. A high-conviction defensive growth holding for patient capital." }
  ],
  watch: {
    C1: [
      { code: "MRD", name: "Meridian Resources", last: 0.590, chg: 3.5, alert: 0.60, dir: "above" },
      { code: "PLS", name: "Pilbara Minerals", last: 3.84, chg: 2.1, alert: null },
      { code: "NVX", name: "Novonix", last: 0.910, chg: 1.1, alert: 0.85, dir: "below" },
      { code: "FMG", name: "Fortescue", last: 22.41, chg: -0.6, alert: null },
      { code: "LTR", name: "Liontown", last: 1.06, chg: -1.9, alert: null },
      { code: "AUR", name: "Aurora Biotech", last: null, chg: 0, alert: null, unl: true }
    ],
    C2: [{ code: "CBA", name: "Commonwealth Bank", last: 132.40, chg: -0.3, alert: 135, dir: "above" }, { code: "WDS", name: "Woodside", last: 26.40, chg: -0.4, alert: null }],
    C3: [{ code: "MQG", name: "Macquarie", last: 214.50, chg: 1.1, alert: null }, { code: "BHP", name: "BHP Group", last: 44.18, chg: 0.8, alert: 46, dir: "above" }],
    C4: [{ code: "FMG", name: "Fortescue", last: 22.41, chg: -0.6, alert: 22.5, dir: "below" }]
  },
  alerts: [],
  audit: []
};

// Derived helpers
export function clientPositions(db: Database, c: string): Position[] {
  return db.positions.filter(p => p.c === c);
}

export function clientOptions(db: Database, c: string): OptionHolding[] {
  return db.options.filter(o => o.c === c);
}

export function posValue(p: Position): number {
  return p.qty * p.last;
}

export function posCost(p: Position): number {
  return p.qty * p.cost;
}

export function posPL(p: Position): number {
  return posValue(p) - posCost(p);
}

export function cashOf(c: string): number {
  const cash: Record<string, number> = { C1: 128450, C2: 64200, C3: 540000, C4: 38900 };
  return cash[c] || 0;
}

export function portfolioValue(db: Database, c: string): number {
  let v = 0;
  clientPositions(db, c).forEach(p => {
    v += posValue(p);
  });
  return v + cashOf(c);
}

export function unlistedValue(db: Database, c: string): number {
  let v = 0;
  clientOptions(db, c).forEach(o => {
    if (!o.listed && o.status === "open") {
      v += o.qty * Math.max(0, o.under - o.strike);
    }
  });
  return v;
}

export function dailyPL(db: Database, c: string): number {
  let v = 0;
  clientPositions(db, c).forEach(p => {
    const factor = p.code === "PLS" ? 0.021 : p.code === "BHP" ? 0.008 : p.code === "FMG" ? -0.006 : p.code === "WDS" ? -0.004 : 0.003;
    v += posValue(p) * factor;
  });
  return v;
}

export function totalPL(db: Database, c: string): number {
  let v = 0;
  clientPositions(db, c).forEach(p => {
    v += posPL(p);
  });
  return v;
}

export function moneyness(o: OptionHolding): number {
  let d = o.under - o.strike;
  if (o.type === "Put") d = -d;
  return d;
}

export function isITM(o: OptionHolding): boolean {
  return moneyness(o) > 0.0001;
}

export function intrinsic(o: OptionHolding): number {
  return Math.max(0, moneyness(o)) * o.qty;
}

// Alert Engine
let alertSeq = 1;
function mkAlert(o: OptionHolding | null, kind: "expiry" | "itm" | "window" | "price", sev: "red" | "amber" | "green", title: string, sub: string, baseTime: Date, clientId?: string): Alert {
  const seq = alertSeq++;
  return {
    id: "A" + seq,
    client: o ? o.c : (clientId || null),
    optId: o ? o.id : null,
    kind,
    sev,
    title,
    sub,
    // Deterministic offset (previously Math.random) — a random timestamp differs
    // between the server render and client hydration, so the sort order flips and
    // React throws a hydration mismatch. Spread alerts 5 minutes apart by seq.
    ts: new Date(baseTime.getTime() - seq * 5 * 60 * 1000),
    ack: false
  };
}

export function scanAlerts(db: Database, baseTime: Date = TODAY): Alert[] {
  const alerts: Alert[] = [];
  alertSeq = 1;

  db.options.forEach(o => {
    if (o.status !== "open") return;
    const clientName = db.clients[o.c]?.name || o.c;
    // escalating expiry
    if (o.dte <= 30 && o.dte >= 0) {
      const sev = o.dte <= 3 ? "red" : "amber";
      const win = [30, 14, 7, 3, 1].filter(t => o.dte <= t).slice(-1)[0] || 30;
      alerts.push(mkAlert(o, "expiry", sev, `${o.code} expires in ${o.dte} day${o.dte === 1 ? "" : "s"}`,
        `${o.listed ? "Listed" : "Unlisted"} · ${clientName} · ${o.qty.toLocaleString("en-AU")} @ $${o.strike.toFixed(2)} · ${win}-day window`, baseTime));
    }
    // in the money
    if (isITM(o)) {
      alerts.push(mkAlert(o, "itm", "green", `${o.code} is in the money`,
        `${clientName} · underlying $${o.under.toFixed(2)} vs strike $${o.strike.toFixed(2)} · intrinsic $${Math.round(intrinsic(o)).toLocaleString("en-AU")}`, baseTime));
    }
    // unlisted + ITM + within exercise window (dte<=14)
    if (!o.listed && isITM(o) && o.dte <= 14 && o.dte >= 0) {
      alerts.push(mkAlert(o, "window", "red", `Act: ${o.code} unlisted, ITM, window closing`,
        `${clientName} · ${o.dte} days to exercise · unlisted options are not auto-exercised`, baseTime));
    }
  });

  // Seed custom price alerts
  alerts.push({
    id: "A" + (alertSeq++),
    client: "C1",
    optId: null,
    kind: "price",
    sev: "green",
    title: "MRD reached $0.59",
    sub: "Custom price alert · target $0.58 · Meridian Resources",
    ts: new Date(baseTime.getTime() - 3600 * 1000),
    ack: false
  });

  alerts.push({
    id: "A" + (alertSeq++),
    client: "C4",
    optId: null,
    kind: "price",
    sev: "amber",
    title: "FMG fell below $22.50",
    sub: "Custom price alert · David Okafor",
    ts: new Date(baseTime.getTime() - 5400 * 1000),
    ack: false
  });

  // Sort alerts: unacknowledged critical red first, then amber, then green, then acknowledged
  const rank = { red: 0, amber: 1, green: 2 };
  alerts.sort((a, b) => {
    if (a.ack !== b.ack) return a.ack ? 1 : -1;
    if (rank[a.sev] !== rank[b.sev]) return rank[a.sev] - rank[b.sev];
    return b.ts.getTime() - a.ts.getTime();
  });

  return alerts;
}

// Generate Seed Audits
export function seedAudits(): AuditEntry[] {
  const base = new Date(2026, 5, 12, 9, 41, 0);
  return [
    { ts: base, user: "S. Goyal (staff)", role: "admin", action: "Signed in", detail: "Vitti staff console · 2FA verified" },
    { ts: new Date(base.getTime() - 10 * 60 * 1000), user: "James Halloran", role: "client", action: "Placed bid", detail: "MRD · $25,000 (client portal)" },
    { ts: new Date(base.getTime() - 25 * 60 * 1000), user: "S. Goyal (staff)", role: "admin", action: "Uploaded note", detail: "MRD initiation note published" },
    { ts: new Date(base.getTime() - 4 * 3600 * 1000), user: "Margaret Chen", role: "client", action: "Signed in", detail: "Client portal · 2FA verified" },
    { ts: new Date(base.getTime() - 24 * 3600 * 1000), user: "System", role: "system", action: "Alert trigger", detail: "NVXO expiry warning (5d left)" }
  ];
}

// Stateful mutations (pure functions returning a new Database copy for React state hooks)
export function mutatePlaceBid(db: Database, placementId: string, clientId: string, amount: number, user: string): Database {
  const auditEntry: AuditEntry = {
    ts: new Date(),
    user,
    role: clientId === "admin" ? "admin" : "client",
    action: "Placed bid",
    detail: `${db.placements.find(p => p.id === placementId)?.code} · $${amount.toLocaleString("en-AU")} (${clientId === "admin" ? "adviser bid" : "client portal"})`
  };

  const placements = db.placements.map(p => {
    if (p.id !== placementId) return p;
    const bidIndex = p.bids.findIndex(b => b.c === clientId);
    const newBids = [...p.bids];
    if (bidIndex >= 0) {
      newBids[bidIndex] = { ...newBids[bidIndex], amount };
    } else {
      newBids.push({ c: clientId, amount, alloc: null });
    }
    return { ...p, bids: newBids };
  });

  return {
    ...db,
    placements,
    audit: [auditEntry, ...db.audit]
  };
}

export function mutateWithdrawBid(db: Database, placementId: string, clientId: string, user: string): Database {
  const code = db.placements.find(p => p.id === placementId)?.code || "";
  const auditEntry: AuditEntry = {
    ts: new Date(),
    user,
    role: clientId === "admin" ? "admin" : "client",
    action: "Withdrew bid",
    detail: `${code} (${clientId === "admin" ? "adviser withdraw" : "client portal"})`
  };

  const placements = db.placements.map(p => {
    if (p.id !== placementId) return p;
    return {
      ...p,
      bids: p.bids.filter(b => b.c !== clientId)
    };
  });

  return {
    ...db,
    placements,
    audit: [auditEntry, ...db.audit]
  };
}

export function mutateScaleBids(db: Database, placementId: string, clientAllocations: Record<string, number | null>, user: string): Database {
  const placement = db.placements.find(p => p.id === placementId);
  const code = placement?.code || "";
  
  const auditEntry: AuditEntry = {
    ts: new Date(),
    user,
    role: "admin",
    action: "Updated allocations",
    detail: `Allocated raises for ${code}`
  };

  const placements = db.placements.map(p => {
    if (p.id !== placementId) return p;
    const bids = p.bids.map(b => ({
      ...b,
      alloc: clientAllocations[b.c] !== undefined ? clientAllocations[b.c] : b.alloc
    }));
    return { ...p, bids };
  });

  return {
    ...db,
    placements,
    audit: [auditEntry, ...db.audit]
  };
}

export function mutateUpdatePlacementStage(db: Database, placementId: string, stage: "open" | "closed" | "upcoming" | "settled", user: string): Database {
  const placement = db.placements.find(p => p.id === placementId);
  const code = placement?.code || "";
  
  const auditEntry: AuditEntry = {
    ts: new Date(),
    user,
    role: "admin",
    action: "Change deal stage",
    detail: `${code} stage changed to ${stage}`
  };

  const positions = [...db.positions];
  const options = [...db.options];

  const placements = db.placements.map(p => {
    if (p.id !== placementId) return p;
    
    // If we transition to settled, add the shares and attaching options to the client portfolios
    if (stage === "settled" && p.stage !== "settled") {
      p.bids.forEach(b => {
        const allocatedAmount = b.alloc || 0;
        if (allocatedAmount > 0) {
          const qty = Math.round(allocatedAmount / p.price);
          // Add to positions
          positions.push({
            c: b.c,
            code: p.code,
            name: p.name,
            qty,
            cost: p.price,
            last: p.last || p.price,
            sector: "Materials" // Default to materials for placement deals
          });

          // Add attaching options if any
          if (p.opts !== "None") {
            // "1 free option (1:2)" -> ratio is 0.5
            // "1 free option (1:1)" -> ratio is 1.0
            // "1 free option (1:3)" -> ratio is 0.33
            let ratio = 0.5;
            if (p.opts.includes("(1:1)")) ratio = 1.0;
            if (p.opts.includes("(1:3)")) ratio = 1/3;
            
            const optQty = Math.round(qty * ratio);
            options.push({
              id: "O" + (db.options.length + options.length + 1),
              c: b.c,
              code: p.code + "O",
              name: p.name + " options",
              listed: p.code === "MRD" ? false : true, // MRD option is unlisted
              type: "Call",
              qty: optQty,
              strike: p.price * 1.5, // 50% premium strike
              under: p.last || p.price,
              dte: 365, // 1 year to go
              source: "Placement attaching",
              status: "open"
            });
          }
        }
      });
    }

    return { ...p, stage };
  });

  return {
    ...db,
    placements,
    positions,
    options,
    audit: [auditEntry, ...db.audit]
  };
}

export function mutateAckAlert(db: Database, alertId: string, user: string): Database {
  const alerts = db.alerts.map(a => {
    if (a.id === alertId) return { ...a, ack: true };
    return a;
  });

  return {
    ...db,
    alerts
  };
}

export function mutateAddCustomAlert(db: Database, clientId: string, code: string, threshold: number, direction: "above" | "below", user: string): Database {
  const auditEntry: AuditEntry = {
    ts: new Date(),
    user,
    role: "client",
    action: "Created alert",
    detail: `Custom price alert: ${code} ${direction} $${threshold.toFixed(2)}`
  };

  const newAlert: Alert = {
    id: "A_custom_" + (db.alerts.length + 1),
    client: clientId,
    optId: null,
    kind: "price",
    sev: "amber",
    title: `${code} custom alert created`,
    sub: `Notify when ${code} goes ${direction} $${threshold.toFixed(2)}`,
    ts: new Date(),
    ack: false
  };

  // Add alert to watchlists
  const watchList = db.watch[clientId] || [];
  const updatedWatchList = watchList.map(w => {
    if (w.code === code) {
      return { ...w, alert: threshold, dir: direction };
    }
    return w;
  });

  if (!watchList.some(w => w.code === code)) {
    updatedWatchList.push({
      code,
      name: db.positions.find(p => p.code === code)?.name || code,
      last: db.positions.find(p => p.code === code)?.last || null,
      chg: 0,
      alert: threshold,
      dir: direction
    });
  }

  return {
    ...db,
    watch: {
      ...db.watch,
      [clientId]: updatedWatchList
    },
    alerts: [newAlert, ...db.alerts],
    audit: [auditEntry, ...db.audit]
  };
}

export function mutateClientBpayPayment(db: Database, placementId: string, clientId: string, user: string): Database {
  const code = db.placements.find(p => p.id === placementId)?.code || "";
  const placement = db.placements.find(p => p.id === placementId);
  const bid = placement?.bids.find(b => b.c === clientId);
  const allocatedAmount = bid?.alloc || 0;

  const auditEntry: AuditEntry = {
    ts: new Date(),
    user,
    role: "client",
    action: "Notified payment",
    detail: `${code} · $${allocatedAmount.toLocaleString("en-AU")} via BPAY`
  };

  const placements = db.placements.map(p => {
    if (p.id !== placementId) return p;
    return {
      ...p,
      bids: p.bids.map(b => {
        if (b.c === clientId) {
          return { ...b, _paid: true };
        }
        return b;
      })
    };
  });

  return {
    ...db,
    placements,
    audit: [auditEntry, ...db.audit]
  };
}
