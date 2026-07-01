# Low-Level Design (LLD) - Vitti Capital Platform

## 1. Data Schema & Core Interfaces (`lib/db.ts`)
The mock database uses TypeScript interfaces representing the broker registry, positions, deals, logs, and the research/content surfaces. The whole shape is aggregated by the top-level `Database` interface and seeded by `INITIAL_DATABASE`.

### 1.1 Holdings & Deal Entities

```typescript
export interface Client {
  id: string;
  name: string;
  av: string;      // Initials/Avatar abbreviation
  type: string;    // e.g. "Individual · wholesale"
  s708: string;    // s708 certificate expiry date string
}

export interface Position {
  c: string;       // Client ID foreign key
  code: string;    // Stock code (e.g., BHP)
  name: string;
  qty: number;
  cost: number;    // Average cost per share
  last: number;    // Last traded price
  sector: string;
}

export interface OptionHolding {
  id: string;
  c: string;       // Client ID foreign key
  code: string;
  name: string;
  listed: boolean;
  type: "Call" | "Put";
  qty: number;
  strike: number;
  under: number;   // Underlying price
  dte: number;     // Days to expiry (may be negative once expired)
  source: string;  // How it was obtained
  status: "open" | "pending" | "expired";
}

export interface Bid {
  c: string;            // Client ID foreign key
  amount: number;       // Bid (application) amount in dollars
  alloc: number | null; // Allocated amount; null until scaled by staff
  _paid?: boolean;      // BPAY payment notified by client
}

export interface Placement {
  id: string;
  code: string;
  name: string;
  type: string;    // Placement / Pre-IPO / SPP / Rights
  price: number;   // Subscription price
  last: number | null;
  disc: number | null;
  raise: number;   // Raising amount in millions
  min: number;     // Minimum bid
  opts: string;    // Option attachments string (e.g. "1 free option (1:2)")
  stage: "open" | "closed" | "upcoming" | "settled";
  closeDate: Date;
  allocDate: Date;
  settleDate: Date;
  allotDate: Date;
  bids: Bid[];     // List of bids
}
```

### 1.2 Market, Research & Content Entities

```typescript
export interface IndexData {
  code: string; name: string; last: number;
  chg: number;          // % change
  dp?: number;          // display decimal places (default 1)
}

export interface Signal {
  action: "Add" | "Hold" | "Trim" | "Take profit" | "Watch";
  headline: string; detail: string; target: number | null;
}

export interface Sector {
  name: string; mom: number; drivers: string; benef: string[]; // beneficiary codes
}

export interface News {
  time: string; src: string; head: string; impact: string;
  dir: "up" | "dn"; use: string;   // adviser "how to use this" note
}

export interface Goal {            // goal-based discovery on /invest
  k: string; label: string; icon: string; themes: string[]; blurb: string;
}

export interface InvestmentIdea {
  code: string; name: string; theme: string;
  risk: "Low" | "Medium" | "High"; horizon: string;
  conv: number;                    // conviction rating 1–3
  last: number | null; entryLo: number | null; entryHi: number | null;
  target: number | null; hook: string; thesis: string;
  deal?: string;                   // optional Placement id link (live deal)
}

export interface WatchItem {
  code: string; name: string; last: number | null; chg: number;
  alert: number | null;            // price threshold
  dir?: "above" | "below"; unl?: boolean; // unlisted
}

export interface Alert {
  id: string; client: string | null; optId: string | null;
  kind: "expiry" | "itm" | "window" | "price";
  sev: "red" | "amber" | "green";
  title: string; sub: string; ts: Date; ack: boolean;
}

export interface AuditEntry {
  ts: Date; user: string; role: string; action: string; detail: string;
}

export interface ResearchNote  { title: string; time: string; body: string; }
export interface ResearchReport { title: string; kind: string; date: Date; pp: number; }
```

### 1.3 Aggregate Root

```typescript
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
  watch: Record<string, WatchItem[]>;   // keyed by client id
  alerts: Alert[];
  audit: AuditEntry[];
}
```

> **Time base:** `TODAY = new Date(2026, 5, 12)` is the fixed "now" the seed data and the alerts engine are anchored to; `addDays(d, n)` derives the relative deal dates.

---

## 2. Stateful Mutation & Store Data Flow

The following data flow chart illustrates how client actions and staff console updates propagate through the state lifecycle store reactively, mutating data states cleanly:

```mermaid
flowchart TD
    subgraph ClientPortal ["Client Portal (/portal/client)"]
        Workspace["Bidding Workspace"]
    end

    subgraph StaffConsole ["Staff Console (/portal/staff)"]
        Book["Placement Book Manager"]
    end

    subgraph Store ["State Management Layer (Zustand Store)"]
        DBState["Stateful DB State (Zustand state)"]
        MutateBid["mutatePlaceBid / mutateWithdrawBid"]
        Settle["mutateUpdatePlacementStage (Settlement Engine)"]
    end

    subgraph Schema ["Data Schema (lib/db.ts)"]
        Clients["Client Registry"]
        Positions["Positions Table"]
        Options["Options Holdings"]
        Audits["Audit Logs"]
    end

    %% Client Actions
    Workspace -->|"1. Submit Bid (amount)"| MutateBid
    MutateBid -->|"Update bids array"| DBState

    %% Staff Actions
    Book -->|"2. Adjust scaling slider (scalePct)"| Store
    Book -->|"3. Commit Allocations (scale & commit)"| MutateBid
    Book -->|"4. Transition Stage to 'settled'"| Settle

    %% Database mutations
    DBState --> MutateBid
    DBState --> Settle

    %% Settlement updates
    Settle -->|"5. Generate Equity Positions"| Positions
    Settle -->|"6. Generate Option Sweeteners"| Options
    Settle -->|"7. Append Logs"| Audits

    %% State propagation
    DBState -->|"8. Reactively push updates"| Workspace
    DBState -->|"8. Reactively push updates"| Book
```

---

## 3. Stateful Database Mutation Functions
Mutations in `lib/db.ts` are pure functions that accept the database instance, create shallow/deep copies as needed, apply adjustments, append an `AuditEntry` to the front of `db.audit`, and return a new `Database` state. Each is wrapped by a thin action in `useDatabaseStore` that injects `clientId`/`currentUserLabel` (see §6).

### 3.1 Placing and Withdrawing Bids
- `mutatePlaceBid(db, placementId, clientId, amount, user)`: Adds a new bid or updates the existing bid's `amount` for that client on that deal. Logs a `Placed bid` entry.
- `mutateWithdrawBid(db, placementId, clientId, user)`: Removes the client's bid from the deal. Logs a `Withdrew bid` entry.

### 3.2 Allocation Scaling (`mutateScaleBids`)
- `mutateScaleBids(db, placementId, clientAllocations, user)`: Applies a `Record<clientId, number | null>` of allocations onto each matching bid's `alloc` field, leaving untouched bids as-is. Logs an `Updated allocations` entry. Drives the staff scaling slider (§5.2).

### 3.3 Settlement Hook (`mutateUpdatePlacementStage`)
`mutateUpdatePlacementStage(db, placementId, stage, user)` always updates the deal `stage` and logs a `Change deal stage` entry. Additionally, on the transition **into** `"settled"` (from a non-settled stage) it runs the settlement engine over every bid:
1. It iterates through all bids; for `alloc > 0` it computes shares `qty = Math.round(alloc / price)`.
2. It pushes a new `Position` into `db.positions` (cost = subscription `price`, `last = p.last ?? p.price`, `sector` defaults to `"Materials"`).
3. If options are attached (`opts !== "None"`), it parses the ratio from the `opts` string — `(1:1) → 1.0`, `(1:2) → 0.5`, `(1:3) → 1/3` (default `0.5`) — computes `optQty = Math.round(qty * ratio)`, and pushes a new `OptionHolding` with `status: "open"`, `strike = price * 1.5` (a 50% premium), `dte: 365` (1-year expiry), and `code = p.code + "O"`. (Note the MRD deal is special-cased as an **unlisted** attaching option.)

### 3.4 Alerts & Payments
- `mutateAckAlert(db, alertId, user)`: Flags an alert `ack: true` (no audit entry).
- `mutateAddCustomAlert(db, clientId, code, threshold, direction, user)`: Creates a `price` alert, upserts the matching `WatchItem` (adding the security to the client watchlist if absent), and logs a `Created alert` entry.
- `mutateClientBpayPayment(db, placementId, clientId, user)`: Flags the client's bid `_paid: true` and logs a `Notified payment` entry (amount taken from the bid's `alloc`).

---

## 3A. Alert Engine & Derived Helpers (`lib/db.ts`)

### 3A.1 `scanAlerts(db, baseTime = TODAY)`
Pure generator (re-run at store init) that scans every `open` option and emits `Alert` objects:
- **Expiry escalation:** for `0 ≤ dte ≤ 30`, severity is `red` when `dte ≤ 3` else `amber`; the displayed window snaps to the nearest of `[30, 14, 7, 3, 1]`.
- **In-the-money:** any ITM option emits a `green` `itm` alert showing intrinsic value.
- **Exercise window:** an **unlisted, ITM** option with `dte ≤ 14` emits a `red` `window` alert ("not auto-exercised").
- Two seeded custom **`price`** alerts (MRD / FMG) are appended, then the list is sorted: unacknowledged first, then by severity (`red → amber → green`), then newest first.

### 3A.2 `seedAudits()`
Returns the initial five-entry `AuditEntry[]` (staff sign-in, client bid, note upload, client sign-in, system alert) anchored to `2026-06-12 09:41`.

### 3A.3 Financial helpers
`clientPositions` / `clientOptions` (filter by client), `posValue` / `posCost` / `posPL`, `cashOf` (hardcoded per-client cash), `portfolioValue` (positions + cash), `unlistedValue` (intrinsic of open unlisted options), `dailyPL` (per-code factor model), `totalPL`, and the options math `moneyness` / `isITM` / `intrinsic`.

---

## 4. UI Component Engineering

### 4.1 Donut Chart Component (`app/portal/client/positions/page.tsx`)
Rendered inside the portfolio analysis page using functional SVG markup:
- Renders segmented arcs using SVG `<circle>` and `strokeDasharray` properties.
- **Offset Math:** Segment offsets must be precalculated side-effect free during render to comply with React's immutability guidelines:
```typescript
const segsWithOffsets = segs.map((s, idx) => {
  const frac = total ? s.v / total : 0;
  const len = frac * C;
  // Functional reduction sums all prior segment lengths
  const offset = segs.slice(0, idx).reduce((sum, prev) => {
    const prevFrac = total ? prev.v / total : 0;
    return sum + prevFrac * C;
  }, 0);
  return { ...s, len, offset };
});
```

### 4.2 Expiry Urgency Rail (`app/portal/staff/clients/[id]/page.tsx`)
A custom rail visualizing options time-to-expiry using conditional LED segments:
- Draws tick marks corresponding to `[30, 14, 7, 3, 1]` days.
- If `dte` is less than or equal to a threshold, the tick lights up.
- Uses classes `.lit-red` (dangerous window: $\le 3$ days) and `.lit-amber` (warning window: $\le 14$ days).

---

## 5. State Synchronization & Optimization

### 5.1 Login Query Bails
In Next.js, static routes that use `useSearchParams()` must be wrapped in a React `<Suspense>` block. In `app/login/page.tsx`, we structured it by splitting the page:
- `LoginContent`: Logic containing credentials inputs, 2FA forms, and `useSearchParams()` checks.
- `LoginPage` (Export Default): Suspense wrapper ensuring that bailing to CSR doesn't crash builds.

### 5.2 Interactive Bids Scaling Slider (`portal/staff/placements/page.tsx`)
The adviser scaling dashboard features an interactive scaling handle.
- State: `scalePct` (0% to 100%) and individual bid text boxes.
- When the slider drags, it sets the scale percentage and updates all calculated allocation states: `alloc = bid.amount * (scalePct / 100)`.
- Staff can commit allocations, instantly updating the global reactive Zustand store.

### 5.3 Contextual Ask Vitti AI Chat (`portal/client/askvitti/page.tsx`)
- Resets messages state on client switches using render-phase verification:
```typescript
if (clientId !== prevClientId) {
  setPrevClientId(clientId);
  setMessages([ /* Initial seeded messages */ ]);
}
```
- Custom queries are processed by mapping keywords against portfolio valuations (`portfolioValue(db, clientId)`) and options exposure tables (`clientOptions(db, clientId)`) for high-fidelity responses.

### 5.4 Responsive Viewport Adaptations
To ensure native responsiveness on real mobile and tablet devices, the unified portal shell uses conditional styling and markup:
- **Sidebar Aside:** Styled with `hidden md:flex flex-col` to hide the left sidebar layout completely on viewports smaller than `768px` (`md` breakpoint) and display it on larger screens.
- **Bottom Navigation Bar:** Renders bottom nav bar using fixed positioning (`fixed bottom-0 left-0 right-0 z-20`) to anchor the tab bar at the bottom of the device viewport on real mobile and tablet browsers.
- **Main Shell Wrapper:** Uses responsive padding classes (`pb-16 md:pb-0 relative`) on viewports under the `md` breakpoint, ensuring that main page content doesn't get covered by the overlay bottom navigation.

---

## 6. Zustand Store Contract (`store/useDatabaseStore.ts`)
The store wraps `INITIAL_DATABASE` and exposes both the data and the session context, plus one action per mutation:

| State | Type | Purpose |
|-------|------|---------|
| `db` | `Database` | The live in-memory database (alerts + audit seeded at init). |
| `role` | `"client" \| "admin"` | Active workspace. |
| `clientId` | `string` | The logged-in client (default `"C1"`). |
| `viewClient` | `string` | The client a staff member is currently inspecting. |
| `currentUserLabel` | getter | `"S. Goyal (staff)"` for admin, else the client's name — stamped onto audit entries. |

**Actions** (each injects `clientId` / `currentUserLabel` into the matching `mutate*`): `setRole` (also logs a `Signed in` audit entry), `setClientId`, `setViewClient`, `placeBid`, `withdrawBid`, `scaleBids`, `updatePlacementStage`, `ackAlert`, `addCustomAlert`, `notifyBpayPayment`.

---

## 7. Production SQL Schema (`db/schema.sql`)
The repository ships a portable PostgreSQL schema (Supabase / Neon / Aurora) that re-expresses the flat prototype objects as an integrity-constrained relational model. It is **not** wired into the running app — it documents the intended production persistence layer.

### 7.1 Interface → Table Mapping

| `lib/db.ts` (in-memory) | `db/schema.sql` (relational) | Notes |
|-------------------------|------------------------------|-------|
| `Client` | `clients` | `av → initials`, `type → account_type`, `s708 → s708_expiry` (date). Adds `email` (UNIQUE) — login key, resolves which client signs in (natural key for future auth). |
| *(hardcoded `cashOf()`)* | `client_accounts` | Cash is a real per-client row with `currency`, not a hardcoded map. |
| `Position` | `positions` | `name`/`sector`/`last` **not** stored — joined from `securities`. Unique `(client_id, security_code)`. |
| `OptionHolding` | `option_holdings` | `dte` is **computed** from `expiry_date` at read time; `under` comes from `securities` via `underlying_code`. |
| `Placement` + `Bid` | `placements` + `bids` | `disc → discount_pct`, `raise → raise_millions`, `min → min_bid`, `_paid → paid`. One bid per client per deal. |
| `IndexData` | `market_indices` | `dp → decimal_places`, `chg` = % change. |
| `Signal` / `Sector` / `News` | `signals` / `sectors` / `news` | `mom → momentum`, `benef → beneficiaries[]`, `use → use_note`. |
| `recos` | `recommendations` | `tp → target_price`; `name`/`sect` **not** stored — joined from `securities`. One reco per covered security. |
| `note` (`ResearchNote`) | `research_notes` | `time → published`; promoted from a single object to a table of dated notes. |
| `InvestmentIdea` | `investment_ideas` | `conv → conviction (1–3 CHECK)`, `deal → placement_id` FK. `last` not stored — joined from `securities`. |
| `WatchItem` | `watchlist_items` | Threshold/direction columns; unlisted allowed (no FK). |
| `Alert` | `alerts` | `kind`/`severity`/`direction` are enums; partial index on unacknowledged. |
| `AuditEntry` | `audit_log` | **Append-only, month-partitioned**; UPDATE/DELETE blocked by trigger. |
| `ResearchReport` | `research_reports` | `pp → pages`. |
| `Goal` / `themes` | *(not persisted)* | Static UI discovery config (icons, labels, blurbs on `/invest`) — kept in app code, not the DB. See §7.2. |
| *(prototype `Position.last`, `OptionHolding.under`)* | `securities` | Prices live **once** in the shared master table, not per holding. |

### 7.2 Deliberate Divergences
- **Price normalization:** the prototype duplicates `last`/`under` onto each holding for convenience; the schema stores them once in `securities` (cache-friendly, single source of truth).
- **Computed `dte`:** stored as a number in the prototype, derived from `expiry_date - current_date` in SQL so it can never go stale.
- **Cash:** a hardcoded lookup in TS becomes a first-class `client_accounts` row (multi-account / multi-currency ready).
- **Audit immutability:** an in-memory array in TS becomes an append-only, time-partitioned compliance table with a trigger that rejects mutation.
- **Enums & integrity:** free-form strings (`type`, `kind`, `sev`, `dir`, `action`…) are promoted to Postgres enums and FK/UNIQUE/CHECK constraints. The `placement_type` enum also adds `'Rights'`, present in the data model but not enumerated in the TS union.
- **Content persisted vs. UI config:** adviser-authored content in the `Database` aggregate is persisted — `recos → recommendations` and `note → research_notes` join the existing `signals`/`news`/`research_reports` content tables. In contrast, `goals` and `themes` are **not** persisted: they are static discovery scaffolding for the `/invest` page (fixed categories, icons, labels, blurbs) and remain in app code, since they are presentation config rather than mutable data.
- **Production hardening (checklist, not DDL):** Row-Level Security per client, read-replica + Redis caching of shared market data, a connection pooler for serverless Next.js, and automated audit-partition rotation with cold-archive to S3.

---

## 8. Supabase Data Layer (runtime)

The schema above is now wired into the running app for migrated routes. This section documents the runtime layer that reads it.

### 8.1 Next.js version specifics (this codebase)
This is not a stock Next.js — two conventions differ from older docs and drive the code below (verified against `node_modules/next/dist/docs/`):
- **`cookies()` is async** — must be `await cookies()`. The server Supabase client factory is therefore `async`.
- **Middleware is "Proxy"** — session-refresh middleware lives in a root `proxy.ts` (`export function proxy`), not `middleware.ts`. It is added with real auth (not present yet).

### 8.2 Supabase clients (`lib/supabase/`)
- `client.ts` — `createBrowserClient<Database>` for Client Components.
- `server.ts` — `createServerClient<Database>` with `getAll`/`setAll` over the awaited `cookieStore`; `setAll` is wrapped in try/catch (Server Components can't set cookies — the future proxy refreshes the session).
- `database.types.ts` — generated via `supabase gen types typescript --linked`; regenerate after any migration.

### 8.3 Data-access layer (`lib/data/queries.ts`)
Server-only (`import "server-only"`). One `React.cache`-wrapped read function per entity. It returns **denormalized, UI-ready types** (defined in the same file) rather than raw rows:
- Identity uses real UUIDs (`clients.id`, `placements.id`); legacy refs (`C1`, `P1`) are exposed as `.ref`.
- `securities` is loaded once into a `Map` and joined in JS to reconstruct `Position.last/name/sector`, `OptionRow.under`, `RecoRow.name/sector`, `IdeaRow.last`, `WatchRow.last`.
- `OptionRow.dte` is computed from `expiry_date` relative to a `DEMO_TODAY` anchor (2026-06-12, matching the prototype); swap for `new Date()` in production.
- Dates are returned as ISO strings (serializable across the RSC boundary; formatted in the UI).
- `getPlacements` nests `bids` per placement; `getAlerts` reads the (engine-populated) `alerts` table.

### 8.4 Compute helpers (`lib/data/compute.ts`)
Pure functions over DAL shapes — `posValue`, `posCost`, `posPL`, `portfolioValue`, `totalPL`, `moneyness`, `isITM`, `intrinsic`, `unlistedValue`. Only type-only imports from `queries.ts`, so they are erased at compile time and safe to import into Client Components (islands reuse them).

### 8.5 Session bridge (`lib/session.ts`, `app/actions/session.ts`)
Interim replacement for the Zustand session, pending real auth:
- **Read (`lib/session.ts`):** `getSession()` parses the `vitti_session` cookie `{ role, clientId, viewClient }`; `getActiveClientId()` returns `session.clientId` or falls back to the first seeded client (keeps pages renderable pre-login and during migration).
- **Write (`app/actions/session.ts`, `"use server"`):** `signIn(role, email)` resolves the client by `clients.email` (falling back to the first client for staff/unknown emails), writes the cookie, and returns the client `ref` so the login page can keep the legacy store in sync. `setViewClient(id)` (staff) and `signOut()` round it out.
- **Email login:** `clients.email` is the login key (also the natural key for future Supabase Auth). Demo emails: `james@halloran.com.au`, `margaret.chen@outlook.com`, `office@endeavourfo.com.au`, `david.okafor@gmail.com`.

### 8.6 Static discovery config (`lib/data/discovery.ts`)
`GOALS` and `THEMES` for the `/invest` page — the deliberately-not-persisted UI scaffolding (see §7.2). Client-safe constants, imported directly by `InvestClient`.

### 8.7 Migration pattern: server page → client island
Each migrated route is a thin **Server Component** `page.tsx` that resolves the active client (`getActiveClientId`), fetches via the DAL with `Promise.all`, and — for interactive pages — passes the data as props to a `"use client"` island that keeps state/handlers:
- `markets/` → `AlertButton.tsx`; `positions/` → `PositionsClient.tsx` (tabs, donut, trade modal); `invest/` → `InvestClient.tsx` (plan builder, modals); `staff/clients/` → `ClientsTable.tsx` (row navigation).
- `insights/` needs no island (pure display) and is a single Server Component.
- Migrated routes render as **dynamic** (`ƒ`) because the DAL reads `cookies()`.

### 8.8 Legacy gotcha — deterministic alert timestamps
`scanAlerts`/`mkAlert` in `lib/db.ts` previously used `Math.random()` for alert timestamps. Because the Zustand store initializes on both the server render and client hydration of the (still-legacy) portal shell, the random sort order differed between the two, throwing a React hydration mismatch. Timestamps are now derived deterministically from the alert sequence.
