# Vitti Capital - Client & Adviser Dashboard

Vitti Capital is a production-grade, stateful Next.js App Router application written in TypeScript and styled with Tailwind CSS v4. It mirrors the exact visual style and dual-workspace architecture of the single-file prototype (`vitti-capital-platform.html`).

> **Migration status:** the app has been moved from a purely in-memory prototype (Zustand + `lib/db.ts`) to a **Supabase (PostgreSQL) backend**. All portal routes render as Server Components reading live data through the data-access layer, every state mutation is a Server Action writing to Supabase + `audit_log`, and access is enforced by real Supabase Auth plus Postgres RLS. The legacy Zustand store is no longer imported by any route.
>
> **Holdings are no longer demo data.** Two broker CSV exports — a holdings snapshot and a contract-note ledger — are imported by a pipeline (§4.5) that derives realised P&L from the trade history. Where it cannot substantiate a figure it says so rather than guessing: see the [migration status](#5-supabase-migration-status).
>
> **That pipeline now runs itself.** The broker mails both files each weekday morning; a cron job reads that mailbox, imports what it carries, and rebuilds each affected account's P&L (§4.6). The same importers still run from the CLI — the logic lives in `lib/import/run-*.ts` and the two front doors are thin renderers over it. The client profile's P&L table **reads what the recompute stored** rather than deriving it per request, because the full calculation depends on live spot prices and the Placement Tracker workbooks, and a figure shown to a client has to be reproducible afterwards.
>
> **The first real scheduled run rewrote three of those assumptions.** It was killed at the host's 60s ceiling having imported both files and recomputed 13 of 43 accounts, and because the kill landed before any run row was written the failure was *silent*. Three fixes followed and they are the newest layer of the design: the ~17s Placement Tracker parse moved out of the cron path into a **Postgres cache** refreshed by a staff button (§4.6); the recompute is **queued** rather than coupled to the import, so a run that runs out of budget defers work instead of losing it; and the ingest stopped treating a *failed* attachment as done. Separately, every read that decides money now **pages past PostgREST's silent 1,000-row cap** (§4.9) — one real client holds 1,650 contract notes and their whole order history was computed from the first thousand.

---

## 1. Document Directory
Detailed design information is available under the `docs` folder:
* **[High-Level Design (HLD)](docs/HLD.md):** Platform structure, the Supabase persistence + data-access layer, the session bridge, the broker batch-ingress pipeline, the scheduled mail ingest (§3.1f), stored P&L (§3.1g), the tracker cache + recompute queue (§3.1h), dual-workspace flows, and responsive layout.
* **[Low-Level Design (LLD)](docs/LLD.md):** Data interfaces, the production SQL schema + interface→table mapping, the DAL / session / compute modules, state-mutation algorithms, the broker import pipeline and cost-basis reducer (§8.14–8.15), stored P&L and the DB→calculator adapter (§8.18), the morning mail ingest (§8.19), the test doubles (§8.20), the tracker cache + recompute queue (§8.21), row pagination (§8.22), placement-name aliases (§8.23), and UI-chart math.
* **[Requirements](docs/REQUIREMENTS.md):** Prototype → production requirements, chosen providers, and behaviour flow charts.
* **[Production SQL Schema](db/schema.sql):** Portable PostgreSQL DDL (Supabase / Neon / Aurora); also applied as the first Supabase migration.

---

## 2. Directory Structure

Every portal route is a Server Component (✅) that reads the Supabase DAL and delegates interactivity to a colocated `"use client"` island.

```bash
client-dashboard/
│   ├── components/
│   │   └── TablePagination.tsx # Reusable client-side table pagination with segmented pill page-size controls
│   ├── globals.css             # Tailwind v4 theme definitions and custom components
│   ├── layout.tsx              # Root Layout loading Google fonts
│   ├── page.tsx                # Landing / role selector
│   ├── actions/
│   │   ├── session.ts          # Server actions: signIn / setViewClient / signOut (session cookie)
│   │   ├── placements.ts       # Server actions: placeBid / withdrawBid / scaleBids / settlePlacement / notifyBpayPayment
│   │   ├── alerts.ts           # Server actions: ackAlert / addCustomAlert
│   │   ├── exports.ts          # Server action: builds the .xlsx (keeps ExcelJS off the client)
│   │   ├── pnl-overrides.ts    # Server action: staff corrections to a P&L row (audited)
│   │   ├── trades.ts           # Server actions: deleteTradeAction, deleteAllTradesForTickerAction, excludePositionAction (audited with auto P&L recompute)
│   │   ├── pnl.ts              # Server actions: recalculate one client's stored P&L / preview CSV /
│   │   │                       #   refresh the Placement Tracker cache / backfill every account
│   │   └── pnl-calculator.ts   # Server action: in-memory P&L multi-file trade/placement parsing, OAuth URL fetch & export generation
│   ├── api/
│   │   └── ingest/
│   │       ├── morning/route.ts # Cron entry point: read broker mail → import → recompute
│   │       └── health/route.ts  # Read-only mailbox probe — verifies Azure setup, imports nothing
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
│           ├── mismatches/     #   ✅ page.tsx (server) + StaffMismatchesClient.tsx (centralized reconciliation island)
│           │                   #      + MismatchRow.tsx (inline in-place P&L override editor & delete trigger)
│           │                   #      + ManageTradesModal.tsx (contract note inspection, single/bulk trade delete & position dismissal)
│           ├── clients/        #   ✅ page.tsx (server) + ClientsTable.tsx (row-nav island)
│           │   │               #      + BackfillPnlButton.tsx (rebuild stored P&L for every account,
│           │   │               #        plus "Refresh trackers" — the ~17s workbook parse, on demand)
│           │   └── [id]/       #   ✅ page.tsx (server) + ClientDetailClient.tsx (tabbed island:
│           │                   #      holdings · historical P&L · options · bids · alerts)
│           │                   #      Historical P&L renders STORED P&L + Recalculate + 9-tab segmented control
│           │                   #      Options tab renders unified listed + unlisted options with carry valuations
│           │                   #      + RealizedPnlChart.tsx (realised P&L by month, SVG, no deps)
│           │                   #      + PnlRow.tsx (inline editor for a summary row)
│           ├── placements/     #   ✅ page.tsx (server) + StaffPlacementsClient.tsx (scaling & settlement island)
│           ├── options/        #   ✅ page.tsx (server) + StaffOptionsClient.tsx (firm-wide multi-account options island:
│           │                   #      All Accounts / Single Account switcher, account grouping, 446 live options,
│           │                   #      executive KPIs, Gain/Loss tabs, CSV export & pagination)
│           ├── alerts/         #   ✅ page.tsx (server) + StaffAlertsClient.tsx (island)
│           └── audit/          #   ✅ page.tsx (server) + ExportButton.tsx (island)
├── lib/
│   ├── db.ts                   # Legacy in-memory DB — no longer imported by any route (pending removal)
│   ├── fonts.ts                # next/font loader configurations
│   ├── pnl-calculator.ts       # In-memory Excel/CSV trade ledger parser, Placement Tracker auto-merge engine & export generator
│   ├── pnl-calculator.test.ts  # Test suite for in-memory P&L calculator engine (95 tests)
│   ├── session.ts              # Auth session helpers (Supabase getUser): getSession / getActiveClientId / getActor
│   ├── supabase/
│   │   ├── client.ts           # Browser Supabase client (@supabase/ssr)
│   │   ├── server.ts           # Server Supabase client (async cookies)
│   │   ├── admin.ts            # service-role client — BYPASSES RLS. Only the cron ingest and the
│   │   │                       #   P&L recompute, which have no user session, may use it
│   │   └── database.types.ts   # Generated DB types (supabase gen types)
│   ├── data/
│   │   ├── queries.ts          # Data-access layer (read side) — server-only
│   │   ├── compute.ts          # Pure financial helpers, client-safe: posValue, dailyPL, isITM, rollUpRealized
│   │   ├── holdings.ts         # Realised-P&L reads (server-only)
│   │   ├── pnl.ts              # Stored-P&L reads: pnl_summary rows + latest pnl_runs (server-only)
│   │   ├── paged.ts            # pagedSelect — reads EVERY row, past PostgREST's silent 1000 cap
│   │   └── discovery.ts        # Static /invest goal + theme config (not persisted)
│   ├── import/                 # Broker CSV pipeline — pure, dependency-free, shared by Next + CLI
│   │   ├── csv.ts              #   RFC 4180 reader (broker files quote their commas properly)
│   │   ├── normalize.ts        #   Ticker parent codes, DAY-FIRST dates, money coercion
│   │   ├── holdings.ts         #   Holdings-snapshot parser + account/security extraction
│   │   ├── trades.ts           #   Trade-ledger parser + the realised-P&L reducer
│   │   ├── trade-formats.ts    #   The broker's SECOND ledger dialect (ContractNotesListing) → the first
│   │   ├── reconcile.ts        #   Missing-cost-basis worklist + ticker-change suggestions
│   │   ├── runner.ts           #   ImportError · chunked upsert · selectAll (pages past the 1000 cap)
│   │   │                       #   · detectCsvKind (headers, never filenames; both trade dialects)
│   │   ├── run-holdings.ts     #   THE holdings import — prints nothing, exits nothing, returns a result
│   │   ├── run-trades.ts       #   THE trade-ledger import, ditto. CLI + cron both call these
│   │   └── *.test.ts           #   62 tests (parsers, reducer, the dialect, and the runners vs a fake DB)
│   ├── pnl/                    # Database-driven P&L — the calculator engine, fed from Supabase
│   │   ├── from-db.ts          #   Adapter: stored trades → the engine's ParsedTradeRow (SETTLED only)
│   │   ├── recompute.ts        #   One account: aggregate → placements → holdings → options → persist
│   │   ├── providers.ts        #   The expensive shared inputs (cached trackers, spot prices)
│   │   ├── batch.ts            #   Many accounts, ONE cached tracker read + one memoised quote per
│   │   │                       #   ticker; a deadline defers rather than half-finishes
│   │   ├── queue.ts            #   pnl_recompute_queue — work a run could not finish, kept visible
│   │   ├── client-portfolio.ts #   The stored figures, as a CLIENT sees them: same rollup and
│   │   │                       #   overrides as the desk, minus the desk's working notes
│   ├── alias-suggest.ts    #   Proposes clients.placement_aliases from ledger shortfalls —
│   │                       #   propose only, never apply (+ 10 tests)
│   │   ├── tracker-cache.ts    #   The refresh half (~17s parse), staff-triggered only
│   │   ├── tracker-cache-store.ts # The storage/read half — no server-only, so the DB path can read it
│   │   └── recompute.test.ts   #   12 tests
│   ├── ingest/                 # The morning broker-mail ingest
│   │   ├── graph-mail.ts       #   Microsoft Graph mailbox reader (sender allowlist + folder + watermark;
│   │   │                       #   degrades the $filter when Exchange calls it inefficient)
│   │   ├── morning.ts          #   Classify → coverage guardrail → import → enqueue → recompute in budget
│   │   └── morning.test.ts     #   18 tests (fake mailbox + fake DB, no network)
│   ├── test-support/
│   │   └── fake-db.ts          # In-memory PostgREST stand-in, so DB choreography is testable
│   └── export/
│       ├── order-history.ts    # P&L summary rows + CSV (pure, client-safe)
│       ├── stored-pnl.ts       # pnl_summary rows → the same PnlSummaryRow the table and exports use
│       ├── xlsx.ts              # Colour-coded .xlsx via ExcelJS — server-side only
│       └── *.test.ts            # 28 tests incl. an xlsx generate-and-read-back round trip
├── store/
│   ├── usePnlCalculatorStore.ts # P&L Calculator working state — module-scope Zustand so it
│   │                            #   survives navigating between portal tabs. MEMORY ONLY by
│   │                            #   design (never localStorage/sessionStorage); reset() is
│   │                            #   called on sign-out. + 5 tests
│   └── useDatabaseStore.ts     # Legacy Zustand store — no longer imported by any route (pending removal)
├── supabase/
│   ├── config.toml             # Supabase CLI project config
│   ├── seed.sql                # Demo seed data (mirrors INITIAL_DATABASE)
│   └── migrations/             # init · client-email · RLS · multi-account · account-lifecycle ·
│                               #   trade-ledger · pnl-overrides · pnl-summary · mail-ingest ·
│                               #   ingest-cron · recompute-queue + placement-tracker-cache ·
│                               #   client-placement-aliases
├── scripts/
│   ├── seed-auth-users.mjs     # Provisions auth users — no password, no role (both are owned
│   │                           #   elsewhere: OTP login, and the auth.users domain trigger)
│   ├── link-client-login.mjs   # Gives a client row a login: clients.email AND the auth row,
│   │                           #   together, because half of it done never receives a code
│   │                           #   (npm run client:login -- <client-id> <email> | --unlink)
│   ├── login-link.mjs          # Break-glass: mints a code + link WITHOUT sending mail, for the
│   │                           #   dead-mail-provider case that OTP-only login creates
│   ├── backfill-sectors.mjs    # Fills securities.sector from Yahoo (assetProfile) — the column was
│   │                           #   NULL on all 775 rows, so every sector chart read "Other".
│   │                           #   Includes the ORDINARIES behind held options, which inherit it
│   │                           #   (npm run backfill:sectors [-- --all])
│   ├── _import-common.mjs      # CLI plumbing only: argv, file reads, console rendering
│   ├── import-holdings.mjs     # Thin CLI over lib/import/run-holdings.ts
│   ├── diff-pnl-csv.mjs        # Compare two P&L exports ticker-by-ticker (npm run diff:pnl)
│   ├── suggest-placement-aliases.mjs
│   │                           # READ-ONLY: proposes clients.placement_aliases from the
│   │                           #   ledger's own shortfalls (npm run suggest:aliases)
│   └── import-trades.mjs       # Thin CLI over lib/import/run-trades.ts
├── db/
│   └── schema.sql              # Canonical schema reference (= the first migration)
├── docs/
│   ├── HLD.md                  # High-Level Architecture Design
│   ├── LLD.md                  # Low-Level Component Design
│   └── REQUIREMENTS.md         # Prototype → production requirements + flow charts
├── proxy.ts                    # Next 16 Proxy (ex-Middleware): refreshes the Supabase auth session
│                               #   No vercel.json: the ingest is scheduled by Supabase pg_cron (§4.6)
├── .env.local                  # Supabase URL + anon key + service-role key + mailbox config (gitignored)
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
- **Data-access layer:** `lib/data/queries.ts` — server-only read functions returning denormalized, UI-ready shapes (prices/names joined from `securities`, `dte` computed from `expiry_date`), each wrapped in `React.cache`. Pure financial math lives in `lib/data/compute.ts`. Any read that can exceed a thousand rows goes through `pagedSelect` (`lib/data/paged.ts`), because **PostgREST truncates at 1,000 rows without saying so** — see §4.9.
- **Mutations:** all state changes are **Server Actions** (`app/actions/placements.ts`, `app/actions/alerts.ts`) that write to Supabase, append an `audit_log` entry, and `revalidatePath("/portal", "layout")` so the UI reflects the new state. Islands call them from event handlers.
- **Auth & session:** **real Supabase Auth** (email + password). `signInWithPassword` (`app/actions/session.ts`) verifies credentials; the root `proxy.ts` refreshes the session cookie each request; `lib/session.ts` reads identity via `supabase.auth.getUser()` (`getActiveClientId` / `getActor`), with the workspace role in `app_metadata.role`. Only `vitti_view` (staff's inspected client) remains a cookie. Deferred: RLS, route protection, and real TOTP MFA (the login OTP screen is cosmetic).
- **Broker data pipeline:** two CSV exports (holdings snapshot + contract-note ledger — the ledger arriving in **two dialects**, §4.5) with all parsing and P&L logic in `lib/import/` — pure, dependency-free modules the Next server and the CLIs both load. Node 24 strips their types natively, which is why they import each other with an explicit `.ts` extension (`allowImportingTsExtensions`). The imports themselves live in `run-holdings.ts` / `run-trades.ts` under two rules that make them callable from anywhere: **nothing prints** (every figure a caller might show is returned) and **nothing exits** (a refusal is a typed `ImportError`). The CLIs in `scripts/` are renderers over them, and the cron ingest is the second caller. See §4.5–4.6.
- **Scheduled ingest:** the broker mails both files each weekday; Supabase `pg_cron` POSTs to `app/api/ingest/morning/route.ts`, which reads that mailbox over Microsoft Graph, imports what it carries, queues the affected accounts and recomputes as many as its time budget allows. `pg_cron` rather than the host's scheduler because Hobby allows one cron a day and one fixed UTC time cannot cover a 9am Sydney mail across daylight saving. Guarded by a constant-time `CRON_SECRET` comparison, because there is no user here and the work behind it writes across every client's rows. See §4.6.
- **Stored P&L:** `pnl_summary` + `pnl_runs` hold the calculator's output per account, rebuilt by `lib/pnl/recompute.ts`. There is deliberately **one P&L engine** — `lib/pnl-calculator.ts`, written for an uploaded file — and `lib/pnl/from-db.ts` feeds it the database instead of reimplementing it, so the calculator page and the client profile cannot disagree.
- **The two tables the first real cron run made necessary** (`…_recompute_queue_and_tracker_cache.sql`): **`placement_tracker_cache`** holds the parsed Placement Trackers in Postgres (~0.23 MB of JSON against ~17s of parsing), refreshed by a staff **Refresh trackers** button and never by the cron — every cron invocation is a cold function, so an in-process cache never hits and the job paid the parse daily for a workbook nobody had edited. An **empty** cache stops the recompute outright rather than storing rows missing every placement buy side. **`pnl_recompute_queue`** decouples importing from recomputing: the ingest always imports, enqueues what it touched, then recomputes as much as its time budget allows, leaving the rest visibly owed.
- **Testing:** Node's built-in runner, no framework and no dev-dependency — `npm test` runs `node --test "lib/**/*.test.ts" "store/**/*.test.ts"`. 270 tests cover the money-critical paths: day-first date parsing, ticker parent codes, the weighted-average-cost reducer, reconciliation, the export's exit classification, an xlsx generate-and-read-back round trip that asserts on what Excel would actually show, Black-Scholes (against a textbook reference value, plus the degenerate inputs that must collapse to intrinsic rather than `NaN`), the add-on spec parser against every shape the real workbooks contain — both column spellings, the `Unisted` typo, and the expiry-less cells dated off settlement — and the P&L Calculator store's `useState`-compatible setters. The newer suites cover what only appears once a **database** is involved, against an in-memory PostgREST stand-in (`lib/test-support/fake-db.ts`) rather than a live project: which rows a full replace may delete, whether re-running a file double-counts it, that a ticker dropped by both sources leaves the stored P&L, that a cancelled trade never moves it, that a truncated snapshot is quarantined instead of emptying the book, that the ledger replay **reads past PostgREST's 1,000-row cap**, that accounts are queued *before* a recompute is attempted, that an empty tracker cache stops the recompute but not the import, that a **failed or quarantined** attachment is retried rather than treated as done, and that a byte-identical file is imported once rather than once per copy.
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
Create `.env.local` from your Supabase project (Dashboard → Project Settings → API). The `SERVICE_ROLE` key is **server-only** and bypasses RLS. Three things use it and nothing else may: the CLI scripts in `scripts/` (auth seeding §4.4, broker imports §4.5), the cron ingest (§4.6), and the P&L recompute it triggers — all of which run with no user session and write across every client's rows. In the app it is reachable only through `lib/supabase/admin.ts`, which is `import "server-only"` so a Client Component importing it is a build error rather than a runtime leak:
```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_OR_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

#### Weekly position commentary (optional — Claude API)
Each week after the Friday close, a short note is written against every security a client holds — what has been weighing on it, or where it stands if the holder is ahead. Without a key the feature is simply off: the job reports `not-configured` and returns success, and the portal renders exactly as before with no note on the holding.
```bash
ANTHROPIC_API_KEY=sk-ant-...
```
Uses `claude-opus-5` with the server-side web-search tool for market context, on the **Message Batches API** — half price, and it sidesteps the 60-second route ceiling, which 142 web-search-grounded generations cannot fit inside however they are ordered. One tick submits the week's batch, a later tick collects it. See §4.7 for the schedule, and `lib/commentary/` for the prompt, the validation gate and the job.

Cost is roughly one request per **held** security per week — 142 on the current book, not 662, because the market read is written once per security and stored in two framings rather than once per client-position. The system prompt is byte-identical across every request in the batch and carries a cache breakpoint.

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

### 4.4 Sign-in (one-time code by email — no passwords)
Login is a 6-digit code emailed to the address. There is **no password**: a code sent *alongside* one would look like a second factor without being one, since `signInWithPassword` returns a valid session the moment the password is accepted. So the code is the credential, and no session exists until `verifyOtp` succeeds. One login screen for everybody — the `?role=` split is gone.

**Which workspace you land in follows from the email domain.** A trigger on `auth.users` stamps `app_metadata.role` from it: `@vitti.capital` → `admin`, everything else → `client` (`…_role_from_email_domain.sql`). `is_staff()` and every RLS policy are unchanged — they still read `app_metadata.role`.

**Staff need no provisioning.** Any `@vitti.capital` address signs in on first use: the server creates the auth row with the service role, then emails the code. That is safe because finishing a sign-in means *reading mail* at the address, and those mailboxes are the firm's own Microsoft 365 tenant — an outsider can request a code for `ceo@vitti.capital` and will never see it.

**Clients must be provisioned**, because a client login needs two halves that live in different places — `clients.email` (so `getActiveClientId()` and the RLS helper `current_client_id()` can resolve the row) and an `auth.users` row. One script does both:
```bash
npm run client:login -- <client-id> someone@example.com   # link
npm run client:login -- <client-id> --unlink              # undo
```
It refuses `@vitti.capital` addresses — they become staff and would never see the client portal.

**Supabase dashboard, one-time setup** (the app cannot do these):
1. **Custom SMTP** — Resend/SES. The built-in mailer sends a handful of messages per hour and is not for production; without it, nobody can log in.
2. **Email Templates → Magic Link** — paste `supabase/email-templates/magic-link.html`. The default template ships `{{ .ConfirmationURL }}`, so an unedited project emails a *link* and the code box can never be filled. `{{ .Token }}` is the 6 digits.
3. **Email provider → Email OTP Length `6`, Email OTP Expiration `600`** (the template says 10 minutes; keep them in step).
4. **Allow new users to sign up → OFF.** Staff self-service does not need it (the admin API bypasses the setting), and leaving it on exposes `POST /auth/v1/signup` to anyone holding the public anon key.

**Locked out?** `npm run login:link -- you@example.com` mints a code and a link *without sending mail* — the break-glass for a dead mail provider, which with no passwords would otherwise lock out every admin.

> **No account holds a usable password.** `createUser` is called without one (`encrypted_password` stays empty, so the password grant cannot match), and the one legacy demo password was rotated to a discarded random value. Removing the password *form* does not disable password auth; this does.

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
| `run-holdings.ts` | `clients`, `accounts`, `securities`, `positions` | account × security code |
| `run-trades.ts` | `trades`, `realized_pnl` | account × **parent** code |

**Two ledger dialects, one parser.** The broker sends the trade ledger in more than one shape: the fuller export whose columns say what they mean (`CNote`, `Security`, `Value`, `Status = SETTLED`), and the `ContractNotesListing` report the scheduled mail actually carries — same data, different names, and different *encodings* (`B`/`S` sides, single-letter statuses, a sale's units written negative, `Nett` for the fee-inclusive value). `lib/import/trade-formats.ts` rewrites the second into the first so `trades.ts` keeps knowing exactly one shape, and `detectCsvKind` recognises both. Only `S` maps to `SETTLED`; every other status code is stored **verbatim** rather than guessed at, which already excludes it from P&L. That export carries no company name, so the field is left empty rather than filled with the account holder's — names arrive through the holdings snapshot.

**Security codes.** ASX ordinaries are exactly three characters and may contain digits (`ADN`, `AT4`, `PC2`); derivatives extend that root (`EOSXX`, `ADNOD`, `PC2ZZ`). The parent is the **first three characters** — never a literal `XX` strip, which would mangle real codes like `LDX`. Each raw code keeps its own `securities` row (an option and its ordinary trade at different prices, so their units are not additive); `securities.parent_code` links them, and the UI rolls up by `COALESCE(parent_code, code)`.

**Foreign listings are exempt from all of that.** An exchange-qualified code — `RKLB:NAS`, `BRAI:NAS` — is its own parent: `BRAI` is a whole NASDAQ ticker, not `BRA` plus a suffix, and slicing it would invent an ASX-shaped parent and merge unrelated instruments under it. The `O`-after-the-third-character option tell is likewise an ASX convention and is not applied. One rule (`isExchangeQualified`) is shared by the importer and the P&L engine, because the two subsystems disagreeing about what a security *is* surfaces as a P&L discrepancy nobody can explain.

**Accounts the ledger alone knows about are created, not refused.** The snapshot normally creates accounts, but it is a snapshot of what is *currently held* — a client who has sold everything has no rows in it and yet has a full trade history (twelve such accounts appeared in the first real file). The ledger states the holder in `Account Name`, so the account is created from what the broker wrote rather than guessed at. The broker's own errors/suspense account is skipped — matched on the **name** (`ERRORS - …`), not the shape of the reference, since `PLACEVITT` is non-numeric and real. Anything still unresolved is dropped and **reported** rather than failing the file; one unknown account used to reject 4,026 trades across 12 accounts.

**Cost basis** is weighted average, which is exact for a full close and for any sale out of a single-price parcel. A partial sale from a parcel accumulated at several prices sets `realized_pnl.has_partial` so the UI marks it approximate; parcel-level FIFO would be needed for CGT-grade figures.

**Known data gap.** If the ledger starts mid-history it will contain sales of units it never saw bought. Those rows set `realized_pnl.short_history`, their proceeds are counted against **zero cost**, and both the importer and the client's Order History tab say so out loud. The importer also proposes a fix where it can: an orphaned sale whose unit count exactly matches an unsold buy under another ticker is almost always a **ticker change**, and it is reported with the buy value to adopt. Anything else needs an earlier trade export or an opening balance.

Only `SETTLED` trades reach the P&L reducer. `CANCELLED` / `REVERSAL` / `REVERSED` rows are still stored for the audit trail.

Run the pipeline's unit tests (Node's built-in runner, no framework):
```bash
npm test
```

### 4.6 Automated morning ingest (broker mail → database → P&L)

The broker mails both files every weekday morning. `app/api/ingest/morning/route.ts` reads that mailbox, runs the **same** importers as §4.5, queues whatever they touched, and rebuilds as much of that P&L as its time budget allows.

```bash
BROKER_MAILBOX=ecm@vitti.capital                        # must be a real MAILBOX
BROKER_SENDER_ALLOWLIST=reporting@morrisonsecurities.com # comma-separated; required
BROKER_MAIL_FOLDER=BrokerData                            # optional but recommended
BROKER_SUBJECT_PATTERN=                                  # optional regex
CRON_SECRET=<a long random string>
INGEST_BUDGET_MS=40000                                   # optional; default 40s (see below)
PLACEMENT_API_URL=http://3.25.70.124:8000                # optional; the deal-mail feed (see below)
```

**Regenerating types: `npm run types`.** Not `supabase gen types … > file` typed into a PowerShell prompt — PowerShell 5.1's `>` writes **UTF-16LE**, which doubles the file, makes Git treat it as binary, and leaves `grep`/`awk` finding nothing in a file that looks perfectly fine in an editor. It has caught us twice. The npm script runs through cmd, whose redirect does not transcode.

**The deal-mail feed (`PLACEMENT_API_URL`).** Placement and IPO announcements are summarised by a separate system (`Placement_Email` → `placement_api.py` on EC2) and pulled into `placement_candidates` by `/api/ingest/placements`, guarded by the same `CRON_SECRET`. Schedule it like the morning ingest but **separately** — that job is already tight against its ceiling, and a deal summary an hour late costs nothing while a P&L that does not rebuild costs the morning:

```sql
SELECT cron.schedule('deal-mail', '30 0 * * 1-5', $$
  SELECT net.http_post(
    url := '<APP_URL>/api/ingest/placements',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  );
$$);
```

A candidate is **not** a deal: the feed carries a ticker, a subject and prose, but no price, raise size or minimum bid — the three `placements` requires and the three a bid is measured against. Staff **promote** a candidate on the Placements tab, supplying those terms, and only then can bids be booked against it. Note the EC2 endpoint is plain HTTP with no auth today.

> **The tracker write is a QUEUE, not a side effect of one run** (`…_placement_tracker_queue.sql`, `lib/placements/tracker-state.ts`). It used to be handed whatever `storeCandidates` had just reported as *fresh*, and a candidate is fresh exactly once — so a write that failed could never be retried, and the hourly sweep whose whole job is to be the backstop read `fresh = 0` and did nothing.
>
> On 3 Sep 2026 that cost the desk two tabs. NGY's approval mail went out at 23:25 UTC but the upstream feed had not yet created its `2026-09-03` bucket, so the 00:00 sweep could not see it; FBR's mail at 00:06:40 fired the webhook, by which time the bucket held **both** deals. One run therefore had to write two tabs into a 13 MB workbook inside what was left of the route's 60 seconds, and was killed after creating the first sheet and seeding it from `Template` — the tab sat at the far end of the workbook, unformatted, cells empty, with no Overview row, and the second deal was never attempted. The 01:00 sweep found nothing fresh. The desk built both by hand.
>
> Four changes followed:
> - **`tracker_written_at IS NULL` means "owed a tab"**, whoever stored the row and however many runs ago, so a kill, a late feed, a locked workbook or a Graph hiccup all recover on the next run. Each deal is marked **as it settles**, so a run that dies on its second tab keeps the first. The batch is 2 per run — a bound, not a fix; the real answer is an invocation per tab.
> - **The webhook no longer reads only one feed date.** The upstream files a deal under its *Sydney* date, so a mail arriving before 10am there belongs to a bucket that is not the newest one listed, and a one-date read walks straight past it. A matching subject with nothing new behind it now logs *"the mail has outrun the upstream"* rather than as a quiet success.
> - **A leftover tab is finished, not filed beside.** With retries in place, ignoring it would find `FBR` taken, file the deal as `FBR (b)` — asserting a repeat placement that never happened — and leave the unformatted `FBR` there for good. Adoption requires a blank `D3` (the ASX code), which is the tightest signal the tab is ours and unfinished; a tab somebody has typed into is left alone and **named in the run's notes**.
> - **`Date Issued` is a Sydney date.** Taking the UTC prefix of the timestamp dated every pre-open announcement a day early — one deal in nine of that fortnight. It is what the Overview's *Settling today* banner counts from and half of the duplicate key, so a date corrected by hand is a date a later write no longer recognises.

**`BROKER_MAILBOX` must have a mailbox behind it.** A distribution list forwards to its members and stores nothing, so Graph has nothing to open and returns 404 — the error names this outright, because it is otherwise a long afternoon. If the broker mail arrives via a DL, point this at a shared mailbox (or an individual's) that is a **member** of that list.

**Azure.** Add `Mail.Read` as an **Application** permission and grant admin consent — then scope it. `Mail.Read` at application level grants access to *every mailbox in the tenant*, so restrict the app registration with an `ApplicationAccessPolicy` covering only this mailbox (via a mail-enabled security group containing just it). Without that, a leaked client secret reads the whole company's mail.

**A folder beats scanning the inbox.** A mail rule that files broker mail into `BrokerData` makes the scan cheap, removes any chance of touching an unrelated message, and gives the desk a **replay** mechanism: drag a missed file into the folder and the next run picks it up. It is also the fix for the one Graph error that looks like a permissions problem and is not: Exchange rejects a `$filter` it considers too expensive with **HTTP 400 `InefficientFilter`**, and which queries qualify depends on the mailbox's size and indexes. The reader retries with progressively cheaper queries (drop the sort, then drop the server-side sender clause), and **re-applies the sender allowlist in memory on every path** — server-side filtering is a bandwidth optimisation here, never the security boundary. A smaller folder is what stops the degradation being needed at all.

**Scheduled by Supabase `pg_cron`, not the host.** Vercel's Hobby plan allows one cron a day, and one fixed UTC time cannot cover a 9am Sydney mail across daylight saving (9:00 AEST = 23:00 UTC the previous day; 9:00 AEDT = 22:00). `supabase/migrations/…_ingest_cron.sql` schedules **00:00 and 01:00 UTC** on weekdays — 10:00/11:00 in whichever offset is in force. The second entry is a free retry rather than a fallback: attachments dedupe on Graph's own ids and both importers are idempotent, so a run with no new mail does almost nothing. Substitute `<APP_URL>` and `<CRON_SECRET>` in the SQL editor; they are left as placeholders because the file is committed and a secret in git history is far harder to rotate than one pasted into a query.

> **The 60s ceiling, and what it cost.** The first real scheduled run hit it exactly: both files imported, 13 of 43 accounts recomputed, then the host killed the request — before any `ingest_runs` row was written, so the failure was **silent** (`cron.job_run_details` showed a successful POST while `ingest_runs` stayed empty). The measured breakdown was ~17s parsing the Placement Trackers and ~3s per account, against the ~150s that 43 accounts actually needs. Three changes followed, and they are why the same morning now finishes or defers rather than disappearing.

**The import never pays for the recompute.** They are one logical morning but wildly unequal in cost, so they are decoupled. The ingest **always imports**, **enqueues** every account it touched into `pnl_recompute_queue`, and only then recomputes — as many as `INGEST_BUDGET_MS` (default 40s) allows. Accounts that do not fit are left queued and counted in the run's notes; the next run, or the desk's **Rebuild all P&L**, takes them. The queueing happens *before* the recompute is attempted, because enqueueing afterwards would lose exactly the case the queue exists for. Each owed account carries an `attempts` counter and its `last_error`, so one permanently broken account stops looking like ordinary backlog. Work owed from yesterday is picked up even when today's file never mentions it.

**The trackers are parsed on demand, not daily.** Every cron invocation is a cold function, so the calculator's in-process cache never hits there and the job paid the full ~17s each morning for a workbook nobody had edited. The parsed output (~0.23 MB of JSON) now lives in `placement_tracker_cache`, and the parse happens only when a staff member presses **Refresh trackers** on `/portal/staff/clients` — which matches how often placements are actually issued. The URL is stored as a **sha256 hash**, not verbatim: for a link-shared sheet the URL *is* the credential and that table is readable by every staff member. Because a stale cache silently misses anything placed since it was parsed, its age travels with the figures — and an **empty** cache makes the recompute **refuse to store anything**, since rows missing every placement buy side and every option line are indistinguishable from correct ones once written. Refresh after issuing a placement.

**What a run does, in order.** Holdings before trades (the snapshot *creates* the accounts a ledger references), then enqueue, then a recompute over everything owed — one cached tracker read for the whole batch, and each ticker quoted once rather than once per account.

**A file is identified by its CSV headers, never its filename.** `detectCsvKind` matches the column set — either trade dialect, or the holdings snapshot; the broker is free to rename and reorder. Anything matching neither export is recorded as `unrecognised` and skipped (the broker's empty-day report, which carries only a search-criteria block, lands here correctly). Running the wrong importer would be worse than doing nothing.

**Only `imported` and `unrecognised` are final.** A `failed` or `quarantined` attachment is offered again next run: its cause is usually something a later run fixes — a missing account a subsequent snapshot creates, a coverage shortfall a corrected file resolves. Treating those as done is how a temporary problem becomes a permanent skip, and it happened: three trade files failed on unknown accounts, and once the importer was taught to create them the fix could not take effect because the files were already marked seen. Byte-identical copies *are* skipped — the broker re-sends the same full-history export every morning, three identical 4,026-row files sat in the mailbox, and re-importing one measured 10.8s — so an attachment whose `sha256` matches one already imported is recorded as `duplicate` and left alone.

**The watermark advances only when nothing is outstanding** — every attachment in the window settled *and* nothing left owed. The attachment table is what guarantees correctness; the watermark is only an optimisation to avoid re-listing old mail, so when the two disagree the watermark yields. Re-reading a message costs a Graph call; skipping one costs the day's data. A run with deferred work reports `partial`, not `ok`.

> **The coverage guardrail.** The holdings import is a **full replace**: every account in the file has its positions deleted and rewritten, so a truncated export would faithfully wipe the accounts it omits. Before applying one, the ingest parses it with `--dry-run` semantics and compares its account list against the accounts that currently hold positions. Below **90 %** coverage the file is **quarantined** rather than applied, the reason is stored on the `ingest_attachments` row, and the watermark does **not** advance — so it is offered again tomorrow instead of being silently skipped past. Clients do close accounts; a tenth of the book vanishing overnight is a different event.

Every run and every attachment is written down (`ingest_runs`, `ingest_attachments`) — nobody is watching the output at 9am, so the output has to be recorded. A catch-up run can be triggered by hand with the same secret:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/ingest/morning
```

#### Verifying the setup before 9am

`/api/ingest/health` walks the same path the ingest walks — config → Graph token → mailbox → folder → a filtered message count → the subject filter — and **stops before downloading an attachment**. It uses the ingest's own query ladder, so it reports what the ingest will actually manage rather than what an easier query could, and it names how many recent messages `BROKER_SUBJECT_PATTERN` would keep (and how many it would skip), so the pattern can be written against what is really arriving. Nothing is imported, nothing is written, and each step is reported separately, because "it doesn't work" has five different causes here and the fix for each is in a different console.

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/ingest/health
```

A 404 on the mailbox step names the distribution-list case outright; a 403 points at the missing consent or the access policy. An `ok: true` with *no matching messages* is a real answer too — the mailbox is readable but `BROKER_SENDER_ALLOWLIST` does not match what is actually arriving.

#### Verifying the numbers

**After first deploy, press "Refresh trackers", then "Rebuild all P&L"** on `/portal/staff/clients` — in that order. The client profile renders what the recompute stored, so an account that has never been recomputed has no rows and says so; and with an empty tracker cache the rebuild deliberately stores nothing at all rather than storing figures with no placement buy sides.

Before trusting it, check the engine against the P&L Calculator — the reference implementation, which it shares. The client profile has a **Preview CSV** button that computes **without storing** and downloads the result in the *calculator's own* CSV format, so the two are directly comparable:

```bash
npm run diff:pnl -- calculator-export.csv pnl-preview-<client>.csv
```

The script reads either export format, matches on ticker, and reports rows present on one side only plus any figure differing by more than a cent. It exits non-zero on a difference. Five things legitimately differ and it prints them rather than letting you hunt for a bug: the two sides read **different ledgers** (uploaded file vs the `trades` table), a different **account scope**, a different **placement client hint** (`clients.display_name` vs the name resolved from the file — this moves the *buy* side), **spot prices** that move between runs, and **overrides** plus a stale reporting period on the calculator.

#### When a placement row stays unfilled

The client profile warns when a row's **buy side is missing and a placement could have filled it** but the sheet's participants include nobody recognisable as this client. Rows the contract notes already complete are not counted — a stock bought on-market that was *also* placed to other people will always list strangers, and reporting that buried the real gaps under two dozen non-events.

Two accounts never raise it, because they are not clients: the broker's suspense account (`ERRORS - VITT - …`) and the house account placements pass through on their way out to clients (`PLACEMENT - VITTI CAPITAL …`). A tracker lists the clients in a placement, so it will never name either, and the house account is full of parcels with no matching contract note — it reported **134 tickers** before this. Do **not** answer it with an alias: an alias there would store a real client's parcel against the house account, which is precisely what the unattended recompute refuses to do.

When a real one appears, it is almost always the name. The tracker's `CLIENT NAME` column is hand-typed and `clients.display_name` is not. Spelling is handled automatically — case, punctuation, `Pty Ltd` ≡ `P/L`, `Inv` ≡ `Investments`, `&` ≡ `and`, a trailing `ATF …` — and that is deliberately as far as inference goes, because the same workbooks contain `PSG Capital Ltd` and `PSG Super` against **two different clients**. A matcher loose enough to bridge the one would bridge the other, and a placement parcel would land on the wrong client's P&L.

So the rest is stated rather than guessed — in `clients.placement_aliases`. You do not have to hunt for the candidates:

```bash
npm run suggest:aliases          # read-only; add --all to see the weak guesses too
```

It reads the tracker cache and each client's **ledger** (the contract notes, before any merge), and for every row with a missing buy side asks which unclaimed participant in that placement holds exactly the missing units:

```
── R Chawla & G Vijan PTY LTD ──────────────────────────────────
  "RG Vijan Super Fund"
     HIGH   (quantities agree AND the names share a word)
     AKN   ledger short    833,333 · sheet allocates    833,333  ← exact match  · shared word
     RMI   ledger short    238,095 · sheet allocates    238,095  ← exact match  · shared word
```

**Rebuild all P&L** tells you when this is worth running: it finishes with `N placement row(s) across M account(s) could not be matched to an account holder`, because otherwise those warnings sit one-per-run in `pnl_runs` and the answer costs opening every client profile.

The suggester itself **writes nothing** — it prints `UPDATE` statements to read and run yourself, and only for suggestions carrying both an exact quantity *and* a shared word that no other client also claims. A name two clients both want is printed with the other client named and left out of the SQL; a quantity match with no name signal is printed but never offered, because placement parcels are round numbers and collide by coincidence.

```sql
UPDATE clients
   SET placement_aliases = ARRAY(SELECT DISTINCT unnest(placement_aliases || ARRAY['PSG Investments']))
 WHERE display_name = 'Psg Capital Investments PTY LTD';
```

Aliases are read live, so a **Recalculate** on that client is all that follows — no tracker re-parse, since the workbooks have not changed. They only ever *add* candidates, never redirect an account that already resolved. Add one only when it is certain: an alias moves a parcel onto that client's P&L.

### 4.7 Weekly position commentary (Friday close → notes on holdings)

Set `ANTHROPIC_API_KEY` (§4.2), then schedule `supabase/migrations/…_commentary_cron.sql` the same way as the morning ingest — substitute `<APP_URL>` and `<CRON_SECRET>` in the SQL editor.

It fires **every two hours from 06:00 UTC Friday to 22:00 UTC Sunday**, and each tick is cheap because the job decides for itself what state the week is in:

* the first tick inside the window **submits** one Batch API job covering every currently-held security that has no note for this week;
* later ticks find the `commentary_runs` row for that week and **poll**, then **collect** once the batch has ended;
* a tick on a week already written does nothing.

The window is checked in the job as well as in the schedule — `withinCommentaryWindow` refuses anything before 17:00 Sydney on Friday — because a mis-set cron entry and a manual catch-up arrive as the same request, and neither should write a note against a market that is still open. The week a note belongs to is **its Friday**, resolved on Sydney's clock so a Saturday and a Sunday catch-up top up the same week rather than opening two more (`lib/commentary/week.ts`).

To force a run outside the window:
```bash
curl -X POST "https://<host>/api/commentary/weekly?force=1" -H "Authorization: Bearer $CRON_SECRET"
```

**What the client sees, and what they do not.** Each note exists in two framings of one market read — one for a holder sitting on a loss, one for a holder who is ahead — and the portal picks by the sign of *that client's* own P&L. Two clients in the same stock therefore cannot be told contradictory things about it. Every note is stamped with its week, carries the URLs the search actually returned, and is labelled as general information rather than advice.

**A validation gate stands between the model and the screen** (`lib/commentary/prompt.ts`). A note is *rejected*, not trimmed, if it states a figure of any kind — the client's real numbers are shown next to it and a generated one that disagrees is worse than no note — or if it reads as personal advice ("you should sell", "price target"). One rejected note costs that security its note and nothing else; the reason is recorded in `commentary_runs.notes`. The prompt itself never carries a price or a holder count, so there is nothing to quote back.

**The failure mode to watch for** is a batch submitted and never collected: from `cron.job_run_details` it looks like a series of successful runs, while the client's screen stays empty.
```sql
SELECT * FROM commentary_runs
 WHERE status = 'submitted' AND submitted_at < now() - interval '24 hours';
```

### 4.8 Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### 4.9 Production Build, Lint & Verification
```bash
npm run lint    # ESLint strict validation (0 errors, 0 warnings)
npm test        # 494 automated unit & regression tests (100% pass)
npm run build   # Next.js App Router dynamic production build
```
Migrated routes read the DAL through the async server client (`cookies()`), so they build as **dynamic** (`ƒ`, server-rendered on demand); unmigrated client routes remain statically prerendered shells. A clean build confirms TypeScript constraints, zero ESLint issues, and that `useSearchParams()` Suspense boundaries (see `app/login/page.tsx`) compile without CSR bailout errors.

### 4.10 A quiet failure mode: PostgREST's 1,000-row cap

Supabase's PostgREST returns at most **1,000 rows** and says nothing about it — no error, no flag, just a short array. `.range()` does not lift the cap, it only moves the window. Anywhere a full set is assumed, that is a silent correctness bug, and this codebase assumed it where it decides money:

* one real client holds **1,650 contract notes**, so their Order History, their realised-P&L chart and the Bought / Sold / Fees totals were all computed from the first 1,000 — complete-looking and wrong;
* the realised-P&L replay re-reads an account's *whole* stored ledger to attribute cost chronologically, and was handed the first 1,000 of **3,996** trades.

Every such read now pages until a short page arrives. There are deliberately two copies of the helper: `pagedSelect` in `lib/data/paged.ts` for the DAL (`server-only`), and `selectAll` in `lib/import/runner.ts` for the importers and the recompute, which must stay free of `server-only` so the CLIs can load them. If you add a query that can exceed a thousand rows, use one of them.

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
| Real auth — emailed one-time code, no passwords | ✅ Supabase Auth (`signInWithOtp` → `verifyOtp`) + root `proxy.ts` session refresh + `app_metadata.role`. One login screen for everybody; the workspace follows the **email domain** via a trigger on `auth.users` (`…_role_from_email_domain.sql`), so `@vitti.capital` addresses self-provision on first sign-in and `is_staff()` / every RLS policy stay untouched. Clients are provisioned with `npm run client:login` (both halves — `clients.email` **and** the auth row). No account holds a usable password: `createUser` is called without one and the legacy demo password was rotated to a discarded value. `npm run login:link` is the break-glass for a dead mail provider. LLD §8.32 |
| Route protection | ✅ `proxy.ts` + portal layout redirect unauthenticated → `/login`; `app/portal/staff/layout.tsx` blocks non-admins |
| Row-Level Security | ✅ `supabase/migrations/…_enable_rls.sql` — client-own rows, `is_staff()` bypass, shared reference reads |
| Client portal reads the desk's figures | ✅ The client portal used to read **different sources** from the staff console, and where those were demo-seed tables they were empty — `option_holdings` has never held a row, so the client Options tab was empty for every client while staff saw options fine (they derive from `pnl_summary`). The derivation is now shared (`lib/options/from-stored-pnl.ts`) and the P&L runs the same `storedToSummaryRows` rollup with the same overrides (`lib/pnl/client-portfolio.ts`), so the two screens agree. The desk's working notes — `flagged`, `edited`/`overridden`, `note` — are deliberately **not** carried across; `excludedFromTotal` is reported as a count so a total never quietly omits a holding. Scoping is enforced twice: client-scoped getters plus `is_staff() OR client_id = current_client_id()` RLS. The Options tab renders the **desk's own columns** (Series, Company, Type + moneyness, Quantity, Strike → Spot, Exercise Value, Current Value, Unreal. P&L, Terms) minus the Account column, since every row is this client's — sharing the derivation fixed the data, sharing the columns is what stops the next divergence. `TablePagination` and a search box now cover Holdings, Profit & loss and Options too (one tested account has 334 P&L lines and 74 option series); footer totals are always the whole filtered set, never the page. LLD §8.33 |
| Fabricated client-facing figures removed | ✅ `mtd = pv * 0.018` and `ytd = pv * 0.064` rendered in green as Month/Year to date; `dailyPL()` models a day move from fixed per-security factors; the "auto-generated" morning briefing and the Ask Vitti card asserted hardcoded market colour and day moves. Fine while only the desk opened those screens, not fine once a client could sign in. Replaced with the stored cost base and P&L. Also fixed on the Analytics tab: `+Infinity%` / `+NaN%` in Top movers (zero-cost option grants divided by their cost — and the table SORTED by that, so the infinities took every top slot), an allocation donut summing to 104% (`unlisted || totalAssets * 0.04`, a hardcoded 4% outside the denominator), a single meaningless "Other" sector bar, and a "Portfolio growth" curve that was a hardcoded SVG path under the same invented +6.4%. Ask Vitti was a canned if/else quoting a **price target** nobody gave ("a spec buy with a $0.78 target") and now declines the market question instead. Sector exposure is a **pie** with real data behind it: `securities.sector` was NULL on all 775 rows (the broker export carries no classification), so `npm run backfill:sectors` fills it from Yahoo and options inherit the ordinary's sector via `parent_code` — which took the tested account from "Other 69%" to Basic Materials 76% / Technology 24%. A real month-/year-to-date needs the per-sale dates the staff chart replays |
| Multi-account model | ✅ `…_multi_account.sql` — `accounts` table; holdings/cash/bids gain `account_id`; client switches account via a topbar switcher, staff aggregate across accounts |
| Account lifecycle | ✅ `…_account_lifecycle.sql` — clients self-serve **create** accounts; **merge** requires staff approval (`account_merge_requests`; `/portal/client/accounts` + `/portal/staff/merge-requests`) |
| Account claims (one login, several existing accounts) | ✅ `…_account_claims.sql` — a client enters the **account number** from their broker statement; the request stores the string and resolves nothing (a form that answered would be an oracle for the firm's account numbers). Staff verify against the broker record; `approve_account_claim`, a `SECURITY DEFINER` RPC, re-parents the account and rewrites `client_id` across eight tables in **one transaction**. An account whose owner has a login is refused — use a merge. The emptied broker-created client row is marked `clients.merged_into`, never deleted. The holdings importer no longer rewrites `accounts.client_id` on every run, which would have reversed a claim overnight. LLD §8.34 |
| Weekly position commentary | ✅ `…_security_commentary.sql` + `…_commentary_cron.sql` — one note per **held** security per week (`claude-opus-5`, web-search server tool, Message Batches API), stored in two framings and served by the sign of the client's own P&L. Submitted and collected on separate `pg_cron` ticks because the route has 60 seconds; the week is its **Friday** on Sydney's clock. A validation gate rejects any note that states a figure or reads as advice. Off, not broken, without `ANTHROPIC_API_KEY`. LLD §8.36 |
| Broker data pipeline | ✅ `…_trade_ledger.sql` — `trades` ledger + derived `realized_pnl`; `securities.parent_code` rolls derivatives up to their ordinary; importers in `scripts/import-{holdings,trades}.mjs` with shared pure logic in `lib/import/`; a reconciliation report flags every sale with no cost basis and proposes a ticker-change match where the ledger itself contains one |
| Order history + realised P&L | ✅ `/portal/staff/clients/[id]` **Order history** tab — a P&L-by-company table (one row per ticker, same columns as the exports) plus a diverging **column chart of realised P&L by month**. Zero-cost-basis rows are flagged in both. Holdings live on the same page's Holdings tab; there is deliberately no separate firm-wide holdings route |
| P&L summary export | ✅ one row per company (Row Labels · Company · Buy Qty · Sell Qty · Buy Price · Sell/Current Price · PnL · Position · Type, where Position names the state — Open / Partly open / Closed / Unknown — rather than answering Yes/No) with a summing Grand Total, rendered identically on screen and in both files. **CSV** for data interchange; a real **.xlsx** via ExcelJS for the colour-coded copy — the P&L column is green above zero and red below it (a loss reading `-$1,234.56`, not accounting brackets), on every row and on the Grand Total alike. The workbook is built in a server action so the ~1 MB library never reaches the browser |
| Desk P&L overrides | ✅ `…_pnl_overrides.sql` + `app/actions/pnl-overrides.ts` — an **Edit** button on each summary row lets staff correct Buy Qty / Sell Qty / Buy Price / Sell Price when a source is incomplete. Null = keep the computed value; P&L itself is never stored, so an edited row cannot contradict its own columns. Every edit is audited and marked in the table and both exports |
| In-Memory P&L Calculator | ✅ `/portal/staff/pnl-calculator` — a dedicated admin tool that parses trade ledger Excel/CSV files entirely in-memory with **zero database persistence**. Automatically auto-detects SELL trades (including negative unit fallback `rawUnits < 0`), maps derivative/option tickers (`ENVO → ENV`, `NVOO → NVO`), filters strictly `SETTLED` trades, supports account filtering (`external_ref` bar), an **optional From/To reporting period** on the Contract Date (empty = the lifetime P&L; set = only that period's trades, and only the unlisted options its own placements granted — a placement issued after the period ends cannot grant into it, while the entitlement still needs a parcel *bought* inside it; the holdings snapshot may not invent rows for stocks the period never traded, undated trades are reported rather than silently dropped, and the period is named in the export filename), and multi-file Placement Tracker upload & removal — **one trade file at a time**, a new upload replacing the active one. The placement merge identifies the account holder from the trade file's **`Account` column** resolved through the database (`accounts.external_ref` → `clients.display_name`), falling back to the file name only if that fails — a filename is often wrong (`PKevadiya-….csv` is actually "Sri Guru Nanak Pty Ltd"). A stock placed **more than once** — twice in a year (`KNI (a)` / `KNI (b)` tabs) or a year apart across the two trackers — is no longer summed across those placements; that stacked every parcel on one row and reported a P&L wrong by a whole placement. Each placement is its own record, and the client's own row is the one that fills the summary: matched **by name**, then narrowed by the ledger's **Contract Date year** and by **quantity reconciliation** (the units the ledger cannot account for must equal what the placement delivered). Its Options / Add-Ons cell is what grants the unlisted options, so a placement that granted none cannot inherit another's. Where nothing identifies a placement the row's Buy Qty / Buy Price / P&L are left **blank and flagged red** (`Check Placement Year`) and excluded from the totals rather than guessed. Plus account-scoped DB portfolio holdings sync (`fetchDatabaseHoldingsAction`) for open position market valuation — a **partial exit** (`0 < sellQty < buyQty`) adds the still-held parcel's market value on top of the realised sale, and a **short buy side** (`0 < buyQty < sellQty`) adds the Placement Tracker allocation on top of the recorded buys — flagged `Partial Exit` / `Partial Buy` / `Open` in a **Comments** column. A DB holding the trade file never mentions (free placement options have no contract note, so nothing ever created a row) now gets its own row using the snapshot's cost base, tagged `Listed Options` for an option line (it reached the snapshot with a code, which reads against the modelled `Unlisted Options` rows) or `Open - no ledger history` for an equity — previously the whole position was silently dropped from the P&L. **Unlisted placement options** from the Overview grant column — `Add-Ons` in the 2026 tracker, `Options` in the 2025 one, both matched, since matching only the newer spelling meant a whole year of grants read as absent — (`1:3 @$0.14 Unlisted Expiry 31/12/27`, including multi-tranche cells like `… + 1:2 @$1.00 Unlisted Piggyback Exp 30/06/28`) become their own zero-cost rows. A grant **in the money** is carried at **intrinsic value** (`spot − strike`) — what exercising it is worth, and deliberately less than the model, since an unlisted option offers no market in which to realise time value; anything else is priced with **Black-Scholes** (vol 50% / rate 5% / div 0%). Spot comes from `yahoo-finance2` → the **ASX market-data feed** → DB snapshot, with the source shown so a live quote is never confused with a stale one, and a hover card names which rule set the price and shows every input. Cells that name no expiry (most of the 2025 column) are dated **settlement + 2 years** by desk convention and flagged `assumed` everywhere they surface, rather than being dropped as unpriceable. 9 filter tabs incl. `Unlisted Options` and `Open`; option rows are excluded from `Unmatched` since their legs are not expected to balance. Working state (uploaded files, merges, filters) lives in a module-scope Zustand store so it **survives navigating to another portal tab** — memory only, never browser storage, and cleared on sign-out. Exports formatted Excel (`.xlsx`) and CSV files, named after the client and the period they cover — `pnl-114716-Sri-Guru-Nanak-PTY-LTD-2026-01-01_to_2026-06-30.xlsx`, or today's date when no period is set — with every account in scope contributing its number and name. |
| Stored P&L | ✅ `…_pnl_summary.sql` — `pnl_summary` (account × ticker) + `pnl_runs` (one per computation). The client profile now **renders what was stored** rather than deriving it per request: the full calculation marks open positions to the snapshot, fills placement buy sides from the Placement Trackers (~17 s to download and parse, now read from `placement_tracker_cache` instead) and prices free unlisted options with Black-Scholes off a **live** spot, none of which a page render can reproduce and all of which must be reproducible later if a client was shown the number — hence `pnl_runs`, which records the spot sources, the tracker count and the warnings in force. Crucially there is **no second engine**: `lib/pnl/from-db.ts` reshapes stored `trades` into the calculator's own `ParsedTradeRow` and every downstream stage is the code the calculator page runs, so the two surfaces cannot drift. Overrides are still applied at **read** time, so a correction keeps tracking its sources instead of being frozen in. Held units are their own quantity (`held_qty`, `…_pnl_held_qty.sql`) rather than being folded into the sell side — a client who bought 500 and then another 2,000 holds 2,500 and has sold nothing, and the row used to read `Sell Qty 2,500 · Matched`. The reconciliation that fold provided is kept exactly (`buy_qty = sell_qty + held_qty`, `open_qty` = what neither accounts for) and no P&L figure moves. A row's open/closed state is **verified against the holdings snapshot** (`not_in_holdings`, `…_pnl_holdings_verification.sql`) rather than inferred from `open_qty` — a ledger showing 10,000 bought and 4,000 sold reports 6,000 open whether or not anyone holds them, and where the client's holdings are empty the parcel was sold and the sell contract notes never arrived; those rows now read **Missing Sells / Closed** instead of Open. Only a positive check may close a position, so an account with no snapshot is left as it was. A **Recalculate** button per client, a "calculated at" stamp, and **Rebuild all P&L** on the register |
| Automated morning ingest | ✅ `…_mail_ingest.sql` + `app/api/ingest/morning/route.ts` — a cron job reads the broker's mailbox over Microsoft Graph (sender allowlist, optional folder + subject regex, received-time watermark; the query degrades when Exchange calls it `InefficientFilter`, and the allowlist is re-applied in memory so a degraded query is never a widened one), classifies each attachment **by its CSV headers rather than its filename**, imports holdings before trades, then enqueues and recomputes. Idempotent importers plus id-level dedupe make the repeats free, and a byte-identical resend is recorded `duplicate` rather than re-imported. A holdings file covering under 90 % of the accounts that currently hold positions is **quarantined** — the import is a full replace and would otherwise wipe what it omits. Only `imported` / `unrecognised` are final: a failed or quarantined file is retried next run, and the watermark advances only when nothing is outstanding. `ingest_runs` / `ingest_attachments` record every run and every file, since nobody reads a 9am console |
| Tracker cache + recompute queue | ✅ `…_recompute_queue_and_tracker_cache.sql` — the two tables the first real scheduled run proved necessary. **`placement_tracker_cache`** holds the parsed workbooks (~0.23 MB of JSON for ~17s of parsing) keyed by a **hash** of the URL, refreshed only by the staff **Refresh trackers** button; an empty cache stops the recompute storing anything rather than storing figures with no placement buy sides, and `parsed_at` rides along so a stale parse is visible. **`pnl_recompute_queue`** decouples the import from the recompute: accounts are enqueued *before* any recompute is attempted, the batch stops at a deadline instead of half-finishing an account, and what is left stays counted with its `attempts` and `last_error` |
| Placement tracker write queue | ✅ `…_placement_tracker_queue.sql` — `placement_candidates.tracker_written_at` / `tracker_sheet` / `tracker_attempts` / `tracker_error`. A deal is owed a tab until it has one, so a failed or killed write recovers on the next hourly sweep instead of needing a person to notice. Ordered by attempts first so a deal the workbook keeps refusing cannot starve this morning's; nothing is ever given up on. The migration backfills every existing row as written — without it the first run would decide all 26 candidates were owed tabs and start appending to the desk's live book. LLD §8.28 |
| Role from email domain | ✅ `…_role_from_email_domain.sql` — a trigger on `auth.users` stamps `app_metadata.role` from the address (`@vitti.capital` → `admin`), plus a backfill. Chosen over reading the domain inside `is_staff()` (which would add an `auth.users` lookup to ~20 policy evaluations) and over deriving it in the app (which would put an authorization decision where the database cannot see it). `app_metadata`, never `user_metadata` — the latter is writable by the user it restricts. LLD §8.32 |
| Placement-name aliases | ✅ `…_client_placement_aliases.sql` — `clients.placement_aliases`, the names the hand-typed tracker uses for a client. Spelling is normalised automatically (`Pty Ltd` ≡ `P/L`, `Inv` ≡ `Investments`, `&` ≡ `and`); beyond that the mapping is **stated**, because the same workbooks carry `PSG Capital Ltd` and `PSG Super` against two different clients and a looser matcher would move a parcel between them. Read live by both the calculator and the stored recompute, so the two surfaces cannot fill different rows from one tracker. A sheet's own `Total Confirmation` / `Allowance` rows are no longer read as participants (they doubled its share total and masked the single-participant case), and that single-participant fallback is now the calculator's only — the unattended recompute declines rather than filling from a stranger |
| Full-set reads (PostgREST cap) | ✅ `lib/data/paged.ts` (`pagedSelect`, DAL) + `lib/import/runner.ts` (`selectAll`, importers/recompute) — Supabase truncates at 1,000 rows silently. A client with 1,650 contract notes had their whole order history, chart and totals computed from the first thousand, and the cost-basis replay walked 1,000 of 3,996 trades. Every money-deciding read now pages to the end (§4.9) |
| Mismatched Qty P&L Dashboard | ✅ `/portal/staff/mismatches` — a centralized reconciliation workspace and left-sidebar tab for all quantity discrepancies, short buys, 0-buy records, and un-reconciled trades across all client accounts. Includes KPI summary cards (Total Discrepancies, Pending Fixes, Fixed with Overrides, Affected Clients), segmented filter tabs (`All`, `Pending Fix`, `Fixed / Edited`, `Short Buy`, `0 Buys`), client dropdown filter, live search, and **in-place inline override editing** directly updating `pnl_overrides`. Overridden rows immediately move from **Pending Fixes** into **Fixed with Overrides** with complete audit capabilities |
| Trade Deletion & Position Exclusion | ✅ `app/actions/trades.ts` + `ManageTradesModal.tsx` — 1-click **Delete (🗑️)** icon on **Mismatched Qty** rows. Opens a dedicated transaction manager listing all raw contract notes for that ticker/account with single-click delete, bulk delete for all trades, or 1-click position exclusion. Deletions mark rows `CANCELLED` in `trades` (protected from morning re-import), insert `audit_log` records, and **automatically trigger client P&L recomputations** in the background |
| Firm-Wide Options Register | ✅ `/portal/staff/options` — dedicated multi-account options monitor located in the staff left sidebar (between Placements and PNL Calculator). Ingests **446 live options** (261 listed exchange-traded options + 185 unlisted placement options with Black-Scholes / intrinsic valuations) across all accounts. Features top-level Account switcher (above KPI cards) with option counts per account, structured grouping in "All Accounts" view (Client Name → Account Label/Ref → Ticker) with account differentiators, clean column layout (Series, Company/Description, Type, Quantity, Current Value, Unrealized P&L, Terms/Valuation Notes), dynamic KPI cards, segmented filter tabs (`All Options`, `Listed Options`, `Unlisted Options`, `Gain`, `Loss`), full UTF-8 BOM CSV export, and pagination |
| Client Options Register | ✅ `/portal/staff/clients/[id]` **Options** tab — unified registry of all listed exchange-traded options and unlisted placement grants with Black-Scholes carry valuations, derived directly from the client's P&L summary rows. Includes segmented filter tabs (`All Options`, `Listed Options`, `Unlisted Options`) with live count badges, search, and totals |
| Historical P&L Full-Width Filters | ✅ `/portal/staff/clients/[id]` **Historical P&L** tab (formerly Order History) — full-width segmented control with 9 distinct filters (`All`, `Equities`, `Options`, `Unlisted Options`, `Open`, `Matched`, `Profit Only`, `Loss Only`, `Unmatched`), live search, and persistent Grand Total calculations |
| Reusable Table Pagination | ✅ `app/components/TablePagination.tsx` — clean client-side pagination with item counters, segmented pill rows-per-page selector (`10`, `25`, `50`, `100`, `All`), and smart chevron/page navigation. Adopted across Overview Wholesale Client Register, Clients Register, all Client Detail sub-route tabs (Holdings, Historical P&L, Options, Bids, Alerts), Mismatches, and Staff Options |
| Codebase Type Hardening & Linting | ✅ strict zero-tolerance enforcement for ESLint (`@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars`, `prefer-const`, React Hooks memoization). All database DTOs typed strictly with 0 lint errors, 0 warnings, and 270/270 passing unit tests |
| Market price feed | ⏳ planned — prices come only from the latest holdings snapshot, so valuations are as stale as the last import (the unlisted-option spot *is* live: Yahoo → ASX → snapshot, with the source recorded) |
| Parcel-level (FIFO) cost basis | ⏳ planned — weighted average today; needed for CGT-grade realised figures |
| TOTP MFA | ⏳ planned — the login OTP screen is cosmetic |

> **Cut-over complete + auth enforced.** Every portal route renders as a Server Component reading the Supabase DAL, all state mutations are Server Actions that write to Supabase + `audit_log` and revalidate the portal, login is **real Supabase Auth** (email + password), and access is enforced end-to-end: **route protection** (proxy + layouts) plus **Postgres RLS** so the database itself guarantees a client only ever touches their own rows. The legacy in-memory engine (`lib/db.ts`, `store/useDatabaseStore.ts`) is no longer imported by any route and is pending removal. Real client holdings and realised P&L arrive through the broker-CSV pipeline (§4.5), which now **runs itself** every weekday morning off the broker's mail (§4.6) and rebuilds each affected account's stored P&L. Remaining hardening: real **TOTP 2FA**, a live price feed for ordinary holdings, and parcel-level cost basis.
>
> **It has now run against production, once, and that run is the source of most of the current design.** The mailbox is real and readable; both files imported; the recompute was killed at the host's 60s ceiling having finished 13 of 43 accounts, silently. What came out of it: the tracker parse moved into a Postgres cache off the cron path, the recompute became a queue with a time budget, failed attachments stopped being treated as done, the ledger's second dialect and its ledger-only accounts became supported, and every money-deciding read learned to page past 1,000 rows. The ingest's 18 tests still run against a fake mailbox and a fake database — they encode those lessons rather than replace a real run. Before pressing **Rebuild all P&L**, press **Refresh trackers**, then recalculate one client and reconcile the figures against the P&L Calculator, which runs the same engine.
