# Vitti Capital - Client & Adviser Dashboard

Vitti Capital is a production-grade, stateful Next.js App Router application written in TypeScript and styled with Tailwind CSS v4. It mirrors the exact visual style and dual-workspace architecture of the single-file prototype (`vitti-capital-platform.html`).

> **Migration status:** the app has been moved from a purely in-memory prototype (Zustand + `lib/db.ts`) to a **Supabase (PostgreSQL) backend**. All portal routes render as Server Components reading live data through the data-access layer, every state mutation is a Server Action writing to Supabase + `audit_log`, and access is enforced by real Supabase Auth plus Postgres RLS. The legacy Zustand store is no longer imported by any route.
>
> **Holdings are no longer demo data.** Two broker CSV exports — a holdings snapshot and a contract-note ledger — are imported by an offline pipeline (§4.5) that derives realised P&L from the trade history. Where it cannot substantiate a figure it says so rather than guessing: see the [migration status](#5-supabase-migration-status).

---

## 1. Document Directory
Detailed design information is available under the `docs` folder:
* **[High-Level Design (HLD)](docs/HLD.md):** Platform structure, the Supabase persistence + data-access layer, the session bridge, the broker batch-ingress pipeline, dual-workspace flows, and responsive layout.
* **[Low-Level Design (LLD)](docs/LLD.md):** Data interfaces, the production SQL schema + interface→table mapping, the DAL / session / compute modules, state-mutation algorithms, the broker import pipeline and cost-basis reducer (§8.14–8.15), and UI-chart math.
* **[Requirements](docs/REQUIREMENTS.md):** Prototype → production requirements, chosen providers, and behaviour flow charts.
* **[Production SQL Schema](db/schema.sql):** Portable PostgreSQL DDL (Supabase / Neon / Aurora); also applied as the first Supabase migration.

---

## 2. Directory Structure

Every portal route is a Server Component (✅) that reads the Supabase DAL and delegates interactivity to a colocated `"use client"` island.

```bash
client-dashboard/
├── app/
│   ├── globals.css             # Tailwind v4 theme definitions and custom components
│   ├── layout.tsx              # Root Layout loading Google fonts
│   ├── page.tsx                # Landing / role selector
│   ├── actions/
│   │   ├── session.ts          # Server actions: signIn / setViewClient / signOut (session cookie)
│   │   ├── placements.ts       # Server actions: placeBid / withdrawBid / scaleBids / settlePlacement / notifyBpayPayment
│   │   ├── alerts.ts           # Server actions: ackAlert / addCustomAlert
│   │   ├── exports.ts          # Server action: builds the .xlsx (keeps ExcelJS off the client)
│   │   ├── pnl-overrides.ts    # Server action: staff corrections to a P&L row (audited)
│   │   └── pnl-calculator.ts   # Server action: in-memory P&L multi-file trade/placement parsing, OAuth URL fetch & export generation
│   ├── login/
│   │   └── page.tsx            # Email login (resolves client) + 2FA; writes the session cookie
│   └── portal/
│       ├── layout.tsx          # ✅ Server shell: fetches session + alerts + nav badges from the DAL
│       ├── PortalShell.tsx     #   Island: sidebar, bottom-bar nav, "More" menu, alerts drawer (ack + sign-out via server actions)
│       ├── client/             # Client views
│       │   ├── page.tsx        #   ✅ Dashboard / Home + DashboardClient.tsx (island)
│       │   ├── invest/         #   ✅ page.tsx (server) + InvestClient.tsx (island) + discovery config
│       │   ├── positions/      #   ✅ page.tsx (server) + PositionsClient.tsx (donut/analytics island)
│       │   ├── insights/       #   ✅ page.tsx (server — signals, sectors, news, research)
│       │   ├── askvitti/       #   ✅ page.tsx (server) + AskVittiClient.tsx (chat island)
│       │   ├── markets/        #   ✅ page.tsx (server) + AlertButton.tsx (island)
│       │   ├── placements/     #   ✅ page.tsx (server) + PlacementsClient.tsx (bidding island)
│       │   ├── options/        #   ✅ page.tsx (server) + OptionsClient.tsx (island)
│       │   ├── watchlist/      #   ✅ page.tsx (server) + WatchlistClient.tsx (island)
│       │   └── alerts/         #   ✅ page.tsx (server) + AlertsClient.tsx (island)
│       └── staff/              # Staff/Adviser views
│           ├── page.tsx        #   ✅ Overview / desk summary + StaffOverviewClient.tsx (island)
│           ├── pnl-calculator/ #   ✅ page.tsx (server) + PnlCalculatorClient.tsx (in-memory ledger tool island)
│           ├── clients/        #   ✅ page.tsx (server) + ClientsTable.tsx (row-nav island)
│           │   └── [id]/       #   ✅ page.tsx (server) + ClientDetailClient.tsx (tabbed island:
│           │                   #      holdings · order history · options · bids · alerts)
│           │                   #      + RealizedPnlChart.tsx (realised P&L by month, SVG, no deps)
│           │                   #      + EditPnlRow.tsx (inline editor for a summary row)
│           ├── placements/     #   ✅ page.tsx (server) + StaffPlacementsClient.tsx (scaling & settlement island)
│           ├── options/        #   ✅ page.tsx (server) + StaffOptionsClient.tsx (firm-wide monitor island)
│           ├── alerts/         #   ✅ page.tsx (server) + StaffAlertsClient.tsx (island)
│           └── audit/          #   ✅ page.tsx (server) + ExportButton.tsx (island)
├── lib/
│   ├── db.ts                   # Legacy in-memory DB — no longer imported by any route (pending removal)
│   ├── fonts.ts                # next/font loader configurations
│   ├── pnl-calculator.ts       # In-memory Excel/CSV trade ledger parser, Placement Tracker auto-merge engine & export generator
│   ├── pnl-calculator.test.ts  # Test suite for in-memory P&L calculator engine (66 tests)
│   ├── session.ts              # Auth session helpers (Supabase getUser): getSession / getActiveClientId / getActor
│   ├── supabase/
│   │   ├── client.ts           # Browser Supabase client (@supabase/ssr)
│   │   ├── server.ts           # Server Supabase client (async cookies)
│   │   └── database.types.ts   # Generated DB types (supabase gen types)
│   ├── data/
│   │   ├── queries.ts          # Data-access layer (read side) — server-only
│   │   ├── compute.ts          # Pure financial helpers, client-safe: posValue, dailyPL, isITM, rollUpRealized
│   │   ├── holdings.ts         # Realised-P&L reads (server-only)
│   │   └── discovery.ts        # Static /invest goal + theme config (not persisted)
│   ├── import/                 # Broker CSV pipeline — pure, dependency-free, shared by Next + CLI
│   │   ├── csv.ts              #   RFC 4180 reader (broker files quote their commas properly)
│   │   ├── normalize.ts        #   Ticker parent codes, DAY-FIRST dates, money coercion
│   │   ├── holdings.ts         #   Holdings-snapshot parser + account/security extraction
│   │   ├── trades.ts           #   Trade-ledger parser + the realised-P&L reducer
│   │   ├── reconcile.ts        #   Missing-cost-basis worklist + ticker-change suggestions
│   │   └── import.test.ts      #   28 tests (node --test)
│   └── export/
│       ├── order-history.ts    # P&L summary rows + CSV (pure, client-safe)
│       ├── xlsx.ts              # Colour-coded .xlsx via ExcelJS — server-side only
│       └── *.test.ts            # 21 tests incl. an xlsx generate-and-read-back round trip
├── store/
│   ├── usePnlCalculatorStore.ts # P&L Calculator working state — module-scope Zustand so it
│   │                            #   survives navigating between portal tabs. MEMORY ONLY by
│   │                            #   design (never localStorage/sessionStorage); reset() is
│   │                            #   called on sign-out. + 5 tests
│   └── useDatabaseStore.ts     # Legacy Zustand store — no longer imported by any route (pending removal)
├── supabase/
│   ├── config.toml             # Supabase CLI project config
│   ├── seed.sql                # Demo seed data (mirrors INITIAL_DATABASE)
│   └── migrations/             # init · client-email · RLS · multi-account · account-lifecycle · trade-ledger · pnl-overrides
├── scripts/
│   ├── seed-auth-users.mjs     # Creates the staff Supabase Auth user (role in app_metadata)
│   ├── _import-common.mjs      # Shared importer plumbing (service-role client, chunked upserts)
│   ├── import-holdings.mjs     # Holdings snapshot → clients / accounts / securities / positions
│   └── import-trades.mjs       # Trade ledger → trades / realized_pnl + reconciliation report
├── db/
│   └── schema.sql              # Canonical schema reference (= the first migration)
├── docs/
│   ├── HLD.md                  # High-Level Architecture Design
│   ├── LLD.md                  # Low-Level Component Design
│   └── REQUIREMENTS.md         # Prototype → production requirements + flow charts
├── proxy.ts                    # Next 16 Proxy (ex-Middleware): refreshes the Supabase auth session
├── .env.local                  # Supabase URL + anon key + service-role key (gitignored)
├── vitti-capital-platform.html # Original single-file prototype (visual source of truth)
├── next.config.ts
├── eslint.config.mjs
├── postcss.config.mjs
├── package.json
└── tsconfig.json
```

---

## 3. Technology Stack & Features

- **Framework:** Next.js 16 (App Router) & React 19. Note the version specifics this codebase relies on: `cookies()` is **async** (`await cookies()`), and Middleware is now **Proxy** (`proxy.ts`).
- **Backend:** **Supabase (PostgreSQL)** via `@supabase/ssr` — a browser client (`lib/supabase/client.ts`) and an async server client (`lib/supabase/server.ts`), with types generated by `supabase gen types` into `lib/supabase/database.types.ts`.
- **Data-access layer:** `lib/data/queries.ts` — server-only read functions returning denormalized, UI-ready shapes (prices/names joined from `securities`, `dte` computed from `expiry_date`), each wrapped in `React.cache`. Pure financial math lives in `lib/data/compute.ts`.
- **Mutations:** all state changes are **Server Actions** (`app/actions/placements.ts`, `app/actions/alerts.ts`) that write to Supabase, append an `audit_log` entry, and `revalidatePath("/portal", "layout")` so the UI reflects the new state. Islands call them from event handlers.
- **Auth & session:** **real Supabase Auth** (email + password). `signInWithPassword` (`app/actions/session.ts`) verifies credentials; the root `proxy.ts` refreshes the session cookie each request; `lib/session.ts` reads identity via `supabase.auth.getUser()` (`getActiveClientId` / `getActor`), with the workspace role in `app_metadata.role`. Only `vitti_view` (staff's inspected client) remains a cookie. Deferred: RLS, route protection, and real TOTP MFA (the login OTP screen is cosmetic).
- **Broker data pipeline:** two CSV exports (holdings snapshot + contract-note ledger) are imported by plain-Node CLIs in `scripts/`, with all parsing and P&L logic in `lib/import/` — pure, dependency-free modules the Next server and the CLIs both load. Node 24 strips their types natively, which is why they import each other with an explicit `.ts` extension (`allowImportingTsExtensions`). See §4.5.
- **Testing:** Node's built-in runner, no framework and no dev-dependency — `npm test` runs `node --test "lib/**/*.test.ts" "store/**/*.test.ts"`. 124 tests cover the money-critical paths: day-first date parsing, ticker parent codes, the weighted-average-cost reducer, reconciliation, the export's exit classification, an xlsx generate-and-read-back round trip that asserts on what Excel would actually show, Black-Scholes (against a textbook reference value, plus the degenerate inputs that must collapse to intrinsic rather than `NaN`), the Add-Ons spec parser against every shape the real workbook contains, and the P&L Calculator store's `useState`-compatible setters.
- **Spreadsheets:** `exceljs` is the one non-Supabase runtime dependency, and it is confined to a **server action** (`app/actions/exports.ts`) — a build check confirms it appears in no client chunk, so the browser only ever receives the finished bytes.
- **Charts:** hand-written SVG, no charting library — a diverging bar chart for realised P&L (`RealizedPnlChart.tsx`). The `--color-gain`/`--color-loss` pair was validated for colour-vision deficiency and lands in the ΔE 6–8 floor band, so polarity is carried by **bar direction and signed value labels** as well as hue.
- **Styling:** Tailwind CSS v4 with custom post-css and raw theme bindings inside `app/globals.css`.
- **Fonts:** `Fraunces` (serif accent headers), `Hanken Grotesk` (clean sans body text), and `IBM Plex Mono` (financial figures and metrics).
- **Legacy state engine:** the in-memory **Zustand** store (`useDatabaseStore.ts`) and `lib/db.ts` are fully superseded by the DAL + Server Actions and are no longer imported by any route (pending removal).
- **Client-side session state:** one deliberate exception to "state lives in Supabase" — the [P&L Calculator](#5-supabase-migration-status) keeps its working set in a module-scope Zustand store (`store/usePnlCalculatorStore.ts`) so a long analysis session survives navigating between portal tabs. It is **memory only**, never written to browser storage, which keeps the tool's zero-persistence contract intact.
- **Responsive Shell:** A single portal shell adapts natively across breakpoints — a persistent left sidebar on desktop (`md`+) collapses to a fixed bottom navigation bar plus a "More" overflow menu on mobile/tablet viewports (pure CSS responsiveness).
- **Production Schema:** A portable PostgreSQL DDL (`db/schema.sql`) modelling the normalized, integrity-constrained relational schema; applied to Supabase as an ordered migration.

---

## 4. Getting Started

### 4.1 Installation
Install project dependencies (peer-dep flag needed on this bleeding-edge Next 16 / React 19 tree):
```bash
npm install --legacy-peer-deps
```

### 4.2 Environment
Create `.env.local` from your Supabase project (Dashboard → Project Settings → API). The `SERVICE_ROLE` key is **server-only** — it is used solely by the CLI scripts in `scripts/` (auth seeding §4.4, broker imports §4.5), which need to bypass RLS, and must never reach the browser:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_OR_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY   # for scripts/seed-auth-users.mjs only
```

#### Private spreadsheet links (optional — P&L calculator)
The P&L calculator's **Placement Tracker Integration** card accepts a pasted link instead of a file upload. Public "anyone with the link" URLs work with no configuration. To also read **private** files, add machine credentials — `lib/remote-sheets.ts` uses them to fetch the workbook server-side. Both blocks are optional and independent; without them the calculator falls back to the anonymous fetch and tells the user which credentials would fix the failure.

**Google Sheets / Drive** — GCP Console → IAM & Admin → Service Accounts → create one → Keys → *Add key* → JSON. Enable the **Google Drive API** on that project. Then, for each private sheet: *Share* → add the service account's email as **Viewer**.
```bash
GOOGLE_SERVICE_ACCOUNT_EMAIL=pnl-reader@your-project.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
```

**SharePoint / OneDrive** — Entra ID (Azure AD) → App registrations → new registration → *Certificates & secrets* for the client secret, and *API permissions* → Microsoft Graph → **Application** permissions → `Files.Read.All` (plus `Sites.Read.All` for SharePoint), then **Grant admin consent**.
```bash
MICROSOFT_TENANT_ID=YOUR_TENANT_ID
MICROSOFT_CLIENT_ID=YOUR_APP_CLIENT_ID
MICROSOFT_CLIENT_SECRET=YOUR_CLIENT_SECRET
```
The private key is multi-line — keep it double-quoted, either with real newlines or `\n` escapes. Access tokens are minted per process and cached in memory until just before they expire; bearer tokens are only ever sent to `oauth2.googleapis.com` / `googleapis.com` / `graph.microsoft.com`, never to the pasted URL's host.

#### Standing Placement Tracker links (optional — P&L calculator)
So the desk never has to paste the same link again, set one or more **permanent** tracker URLs. The calculator loads them automatically, once per session, **right after a trade file is loaded** — not on page open, because on a cold cache the parse would starve that very upload's own server actions (see below). Separate several links with commas, semicolons or newlines — the desk keeps one workbook per year and they are merged exactly as if uploaded by hand:
```bash
PLACEMENT_TRACKER_URL="https://…/2026-tracker
https://…/2025-tracker"
```

> **In a hosting provider's environment UI, paste the URL *without* surrounding quotes.** A `.env` file needs `KEY="value"` and dotenv strips the quotes for you; a provider's UI stores the value verbatim, so the quote becomes part of the URL and the link is rejected. (Both cases are now handled — quotes are stripped either way — but leaving them out is clearer.)
>
> **Separate the links with a newline or a space, not a bare comma.** A SharePoint "copy link" URL contains `%2C` in its query string, and pasting it through a hosting provider's environment-variable UI can decode that to a real comma — splitting on commas then tears the URL in half. This is exactly what broke a deployed build: the long 2026 link became a truncated URL plus the fragment `Refreshin`, so it failed while the short 2025 link kept working and only one tracker appeared. A comma or semicolon is still accepted, but only where the next thing is another `http(s)://`, and anything that is not a URL is logged rather than silently attempted.
>
> Prefer the short share form (**Share → Copy link**, e.g. `…/:x:/g/personal/…/IQCabc?e=xxxx`) over the long `…/_layouts/15/doc2.aspx?sourcedoc=…&wdinitialsession=…` URL that the browser shows while a workbook is open for editing. The short form is stable, has no session parameters, and avoids the whole problem.
Deliberately **not** a `NEXT_PUBLIC_` variable: for an "anyone with the link" sheet the URL *is* the credential, so it is read server-side only and never reaches the browser — the UI shows the downloaded filename instead. Private links still need the machine credentials above.

These workbooks are big — the real 2026 and 2025 trackers are 12.5 MB and 9.3 MB across 177 sheets. Four things follow:

* They are parsed with **SheetJS, not ExcelJS**, reading only the rows that matter. ExcelJS materialises the whole workbook: it needed **1,628 MB of heap** for the 2026 file alone, past the **1 GB default of a Vercel function** — which is why a deployed build showed only the smaller 2025 tracker. SheetJS needs **113 MB** and both files parse in 10.7 s instead of 46.8 s. Output was verified identical across 200 tickers and 900 allocations, with zero numeric differences.
* `maxDuration = 60` is set on the route, since the platform default (10 s Hobby / 15 s Pro) is below the ~17 s cold-cache cost of downloading and parsing both.
* Links are parsed **sequentially**. Parsing is CPU-bound and single-threaded, so running both at once saved nothing while roughly doubling peak memory.
* Parsed results are **cached server-side for 10 minutes** per URL, so the ~48 s is paid once per server process rather than once per session; a cache hit returns in 0 ms. The TTL keeps placements added during the day visible. If a refresh fails, the last good copy is served with a note rather than the tracker disappearing.
* The load runs **once per session**, guarded by a flag in the calculator store rather than component state — the route remounts on every portal tab navigation, and a component-level flag would repeat the cost each visit.
* It is triggered **after** the trade file is processed, never on mount. Node is single-threaded, so a cold-cache parse blocks every other server action: a trade file uploaded during that window had its account-holder lookup, DB-holdings sync and spot-price fetch all queued behind ~48 s of Excel parsing, which showed up as an upload hanging on "parsing…" or failing outright.
* While the trackers are fetching and merging, the results view is replaced by a single clear loader rather than rendering a half-enriched table that then jumps.

The manual paste field remains for one-offs, and the calculator's **Reset** keeps the standing trackers (they are configuration, not the user's work).

### 4.3 Database (Supabase)
Apply the schema and seed the demo data:
```bash
npx supabase link --project-ref <YOUR_PROJECT_REF>
npx supabase db push          # applies supabase/migrations/*
# then run supabase/seed.sql in the Dashboard SQL Editor (or via psql)
```
After a schema change, regenerate types: `npx supabase gen types typescript --linked > lib/supabase/database.types.ts`.

### 4.4 Auth user (staff login)
Create the staff Supabase Auth user, stamping the workspace role into `app_metadata.role`:
```bash
node --env-file=.env.local scripts/seed-auth-users.mjs
```
Idempotent (re-running updates the existing user). Sign in as **`goyal.s@vitti.capital`** / **`demo1234`**. The 6-digit OTP screen is cosmetic; any digits proceed.

Only staff are seeded. Clients now come from the broker import (§4.5), which creates them **without an email** — so they cannot log in until one is attached to `clients.email`. This does not affect the admin workspace: `is_staff()` gives staff every account. To enable a client login, set that client's email and add them to `USERS` in the script with role `client`.

### 4.5 Broker data import (real client holdings)

Two CSV exports feed the platform, and they answer different questions. Import the **holdings snapshot first** — it creates the clients, accounts and securities that the trade ledger then references.

```bash
# 1. Holdings snapshot — current units, average cost and market price.
#    Full replace of `positions` for every account in the file.
npm run import:holdings -- ClientHoldingsallaccounts-<stamp>.csv

# 2. Trade ledger (contract notes) — realised P&L.
#    Upserted by contract note, then `realized_pnl` is rebuilt.
npm run import:trades -- <contract-notes>.csv
```

Add `--dry-run` to either to print the parsed totals and a P&L preview **without writing anything**. Both are idempotent — re-running the same file converges to the same rows.

| Stage | Owns | Grain |
|---|---|---|
| `import-holdings.mjs` | `clients`, `accounts`, `securities`, `positions` | account × security code |
| `import-trades.mjs` | `trades`, `realized_pnl` | account × **parent** code |

**Security codes.** ASX ordinaries are exactly three characters and may contain digits (`ADN`, `AT4`, `PC2`); derivatives extend that root (`EOSXX`, `ADNOD`, `PC2ZZ`). The parent is the **first three characters** — never a literal `XX` strip, which would mangle real codes like `LDX`. Each raw code keeps its own `securities` row (an option and its ordinary trade at different prices, so their units are not additive); `securities.parent_code` links them, and the UI rolls up by `COALESCE(parent_code, code)`.

**Cost basis** is weighted average, which is exact for a full close and for any sale out of a single-price parcel. A partial sale from a parcel accumulated at several prices sets `realized_pnl.has_partial` so the UI marks it approximate; parcel-level FIFO would be needed for CGT-grade figures.

**Known data gap.** If the ledger starts mid-history it will contain sales of units it never saw bought. Those rows set `realized_pnl.short_history`, their proceeds are counted against **zero cost**, and both the importer and the client's Order History tab say so out loud. The importer also proposes a fix where it can: an orphaned sale whose unit count exactly matches an unsold buy under another ticker is almost always a **ticker change**, and it is reported with the buy value to adopt. Anything else needs an earlier trade export or an opening balance.

Only `SETTLED` trades reach the P&L reducer. `CANCELLED` / `REVERSAL` / `REVERSED` rows are still stored for the audit trail.

Run the pipeline's unit tests (Node's built-in runner, no framework):
```bash
npm test
```

### 4.6 Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### 4.7 Production Build & Verification
```bash
npm run lint
npm run build
```
Migrated routes read the DAL through the async server client (`cookies()`), so they build as **dynamic** (`ƒ`, server-rendered on demand); unmigrated client routes remain statically prerendered shells. A clean build confirms TypeScript constraints and that `useSearchParams()` Suspense boundaries (see `app/login/page.tsx`) compile without CSR bailout errors.

---

## 5. Supabase Migration Status

| Layer | State |
|---|---|
| Schema + seed on Supabase | ✅ applied (`supabase/migrations/`, `supabase/seed.sql`) |
| Data-access layer + generated types | ✅ `lib/data/queries.ts`, `lib/supabase/*` |
| Auth session bridge (`getUser()`) | ✅ `lib/session.ts`, `app/actions/session.ts` |
| Migrated routes — client | ✅ dashboard, invest, positions, insights, markets, placements, options, watchlist, alerts, askvitti |
| Migrated routes — staff | ✅ overview, clients, clients/[id], placements, options, alerts, audit |
| Mutations → server actions | ✅ `app/actions/placements.ts` (placeBid, withdrawBid, scaleBids, settlePlacement, notifyBpayPayment) · `app/actions/alerts.ts` (ackAlert, addCustomAlert) |
| Portal layout on DAL/session | ✅ server `layout.tsx` fetches session + badges + alerts; interactivity in `PortalShell.tsx` (ack + sign-out call server actions) |
| Real auth — email + password | ✅ Supabase Auth (`signInWithPassword`) + root `proxy.ts` session refresh + `app_metadata.role`; staff user via `scripts/seed-auth-users.mjs` (clients arrive emailless from the broker import, so their logins are not seeded) |
| Route protection | ✅ `proxy.ts` + portal layout redirect unauthenticated → `/login`; `app/portal/staff/layout.tsx` blocks non-admins |
| Row-Level Security | ✅ `supabase/migrations/…_enable_rls.sql` — client-own rows, `is_staff()` bypass, shared reference reads |
| Multi-account model | ✅ `…_multi_account.sql` — `accounts` table; holdings/cash/bids gain `account_id`; client switches account via a topbar switcher, staff aggregate across accounts |
| Account lifecycle | ✅ `…_account_lifecycle.sql` — clients self-serve **create** accounts; **merge** requires staff approval (`account_merge_requests`; `/portal/client/accounts` + `/portal/staff/merge-requests`) |
| Broker data pipeline | ✅ `…_trade_ledger.sql` — `trades` ledger + derived `realized_pnl`; `securities.parent_code` rolls derivatives up to their ordinary; importers in `scripts/import-{holdings,trades}.mjs` with shared pure logic in `lib/import/`; a reconciliation report flags every sale with no cost basis and proposes a ticker-change match where the ledger itself contains one |
| Order history + realised P&L | ✅ `/portal/staff/clients/[id]` **Order history** tab — a P&L-by-company table (one row per ticker, same columns as the exports) plus a diverging **column chart of realised P&L by month**. Zero-cost-basis rows are flagged in both. Holdings live on the same page's Holdings tab; there is deliberately no separate firm-wide holdings route |
| P&L summary export | ✅ one row per company (Row Labels · Company · Buy Qty · Sell Qty · Buy Price · Sell/Current Price · PnL · Open Positions · Type) with a summing Grand Total, rendered identically on screen and in both files. **CSV** for data interchange; a real **.xlsx** via ExcelJS for the colour-coded copy — amber = open, green = exited, red bold = the two sources disagree. The workbook is built in a server action so the ~1 MB library never reaches the browser |
| Desk P&L overrides | ✅ `…_pnl_overrides.sql` + `app/actions/pnl-overrides.ts` — an **Edit** button on each summary row lets staff correct Buy Qty / Sell Qty / Buy Price / Sell Price when a source is incomplete. Null = keep the computed value; P&L itself is never stored, so an edited row cannot contradict its own columns. Every edit is audited and marked in the table and both exports |
| In-Memory P&L Calculator | ✅ `/portal/staff/pnl-calculator` — a dedicated admin tool that parses trade ledger Excel/CSV files entirely in-memory with **zero database persistence**. Automatically auto-detects SELL trades (including negative unit fallback `rawUnits < 0`), maps derivative/option tickers (`ENVO → ENV`, `NVOO → NVO`), filters strictly `SETTLED` trades, supports account filtering (`external_ref` bar), and multi-file Placement Tracker upload & removal — **one trade file at a time**, a new upload replacing the active one. The placement merge identifies the account holder from the trade file's **`Account` column** resolved through the database (`accounts.external_ref` → `clients.display_name`), falling back to the file name only if that fails — a filename is often wrong (`PKevadiya-….csv` is actually "Sri Guru Nanak Pty Ltd"). Plus account-scoped DB portfolio holdings sync (`fetchDatabaseHoldingsAction`) for open position market valuation — a **partial exit** (`0 < sellQty < buyQty`) adds the still-held parcel's market value on top of the realised sale, and a **short buy side** (`0 < buyQty < sellQty`) adds the Placement Tracker allocation on top of the recorded buys — flagged `Partial Exit` / `Partial Buy` / `Open` in a **Comments** column. A DB holding the trade file never mentions (free placement options have no contract note, so nothing ever created a row) now gets its own row using the snapshot's cost base, tagged `DB Holding` — previously the whole position was silently dropped from the P&L. **Unlisted placement options** from the Overview `Add-Ons` column (`1:3 @$0.14 Unlisted Expiry 31/12/27`, including multi-tranche cells like `… + 1:2 @$1.00 Unlisted Piggyback Exp 30/06/28`) become their own zero-cost rows priced with **Black-Scholes** (spot from `yahoo-finance2` → the **ASX market-data feed** → DB snapshot, with the source shown so a live quote is never confused with a stale one; vol 50% / rate 5% / div 0%), with a hover card showing every input — a model estimate, not a mark. 9 filter tabs incl. `Unlisted Options` and `Open`; option rows are excluded from `Unmatched` since their legs are not expected to balance. Working state (uploaded files, merges, filters) lives in a module-scope Zustand store so it **survives navigating to another portal tab** — memory only, never browser storage, and cleared on sign-out. Exports formatted Excel (`.xlsx`) and CSV files, named after the client they cover — `pnl-114716-Sri-Guru-Nanak-PTY-LTD-2026-08-05.xlsx` — scoped to whichever account filter is in force. |
| Market price feed | ⏳ planned — prices come only from the latest holdings snapshot, so valuations are as stale as the last import |
| Parcel-level (FIFO) cost basis | ⏳ planned — weighted average today; needed for CGT-grade realised figures |
| TOTP MFA | ⏳ planned — the login OTP screen is cosmetic |

> **Cut-over complete + auth enforced.** Every portal route renders as a Server Component reading the Supabase DAL, all state mutations are Server Actions that write to Supabase + `audit_log` and revalidate the portal, login is **real Supabase Auth** (email + password), and access is enforced end-to-end: **route protection** (proxy + layouts) plus **Postgres RLS** so the database itself guarantees a client only ever touches their own rows. The legacy in-memory engine (`lib/db.ts`, `store/useDatabaseStore.ts`) is no longer imported by any route and is pending removal. Real client holdings and realised P&L now arrive through an offline broker-CSV pipeline (§4.5). Remaining hardening: real **TOTP 2FA**, a live price feed, and parcel-level cost basis.
