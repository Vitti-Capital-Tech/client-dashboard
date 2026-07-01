# Vitti Capital - Client & Adviser Dashboard

Vitti Capital is a production-grade, stateful Next.js App Router application written in TypeScript and styled with Tailwind CSS v4. It mirrors the exact visual style and dual-workspace architecture of the single-file prototype (`vitti-capital-platform.html`).

> **Migration status:** the app has been moved from a purely in-memory prototype (Zustand + `lib/db.ts`) to a **Supabase (PostgreSQL) backend**. All portal routes now render as Server Components reading live data through the data-access layer, every state mutation is a Server Action writing to Supabase + `audit_log`, and the portal shell reads the session-cookie bridge. The legacy Zustand store is no longer imported by any route. The one remaining stage is real authentication (Supabase Auth + RLS) to replace the interim session cookie — see the [migration status](#5-supabase-migration-status).

---

## 1. Document Directory
Detailed design information is available under the `docs` folder:
* **[High-Level Design (HLD)](docs/HLD.md):** Platform structure, the Supabase persistence + data-access layer, the session bridge, dual-workspace flows, and responsive layout.
* **[Low-Level Design (LLD)](docs/LLD.md):** Data interfaces, the production SQL schema + interface→table mapping, the DAL / session / compute modules, state-mutation algorithms, and UI-chart math.
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
│   │   └── alerts.ts           # Server actions: ackAlert / addCustomAlert
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
│           ├── clients/        #   ✅ page.tsx (server) + ClientsTable.tsx (row-nav island)
│           │   └── [id]/       #   ✅ page.tsx (server) + ClientDetailClient.tsx (tabbed detail island)
│           ├── placements/     #   ✅ page.tsx (server) + StaffPlacementsClient.tsx (scaling & settlement island)
│           ├── options/        #   ✅ page.tsx (server) + StaffOptionsClient.tsx (firm-wide monitor island)
│           ├── alerts/         #   ✅ page.tsx (server) + StaffAlertsClient.tsx (island)
│           └── audit/          #   ✅ page.tsx (server) + ExportButton.tsx (island)
├── lib/
│   ├── db.ts                   # Legacy in-memory DB — no longer imported by any route (pending removal)
│   ├── fonts.ts                # next/font loader configurations
│   ├── session.ts              # Session-cookie helpers: getSession / getActiveClientId / getActor
│   ├── supabase/
│   │   ├── client.ts           # Browser Supabase client (@supabase/ssr)
│   │   ├── server.ts           # Server Supabase client (async cookies)
│   │   └── database.types.ts   # Generated DB types (supabase gen types)
│   └── data/
│       ├── queries.ts          # Data-access layer (read side) — server-only
│       ├── compute.ts          # Pure financial helpers over DAL shapes (client-safe): posValue, dailyPL, isITM, …
│       └── discovery.ts        # Static /invest goal + theme config (not persisted)
├── store/
│   └── useDatabaseStore.ts     # Legacy Zustand store — no longer imported by any route (pending removal)
├── supabase/
│   ├── config.toml             # Supabase CLI project config
│   ├── seed.sql                # Demo seed data (mirrors INITIAL_DATABASE)
│   └── migrations/             # init schema + client-email migrations
├── db/
│   └── schema.sql              # Canonical schema reference (= the first migration)
├── docs/
│   ├── HLD.md                  # High-Level Architecture Design
│   ├── LLD.md                  # Low-Level Component Design
│   └── REQUIREMENTS.md         # Prototype → production requirements + flow charts
├── .env.local                  # Supabase URL + anon key (gitignored)
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
- **Session bridge:** an interim cookie (`{ role, clientId, viewClient }`) written by `app/actions/session.ts` and read via `lib/session.ts` (`getSession` / `getActiveClientId` / `getActor` for audit attribution) — real Supabase Auth + RLS will later replace the cookie read with `getUser()`.
- **Styling:** Tailwind CSS v4 with custom post-css and raw theme bindings inside `app/globals.css`.
- **Fonts:** `Fraunces` (serif accent headers), `Hanken Grotesk` (clean sans body text), and `IBM Plex Mono` (financial figures and metrics).
- **Legacy state engine:** the in-memory **Zustand** store (`useDatabaseStore.ts`) and `lib/db.ts` are fully superseded by the DAL + Server Actions and are no longer imported by any route (pending removal).
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
Create `.env.local` from your Supabase project (Dashboard → Project Settings → API — use the public anon/publishable key, **not** service_role):
```bash
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_OR_PUBLISHABLE_KEY
```

### 4.3 Database (Supabase)
Apply the schema and seed the demo data:
```bash
npx supabase link --project-ref <YOUR_PROJECT_REF>
npx supabase db push          # applies supabase/migrations/*
# then run supabase/seed.sql in the Dashboard SQL Editor (or via psql)
```
After a schema change, regenerate types: `npx supabase gen types typescript --linked > lib/supabase/database.types.ts`.

Demo logins (any password / 2FA code works): `james@halloran.com.au`, `margaret.chen@outlook.com`, `office@endeavourfo.com.au`, `david.okafor@gmail.com`.

### 4.4 Run Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### 4.5 Production Build & Verification
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
| Session-cookie bridge + email login | ✅ `lib/session.ts`, `app/actions/session.ts` |
| Migrated routes — client | ✅ dashboard, invest, positions, insights, markets, placements, options, watchlist, alerts, askvitti |
| Migrated routes — staff | ✅ overview, clients, clients/[id], placements, options, alerts, audit |
| Mutations → server actions | ✅ `app/actions/placements.ts` (placeBid, withdrawBid, scaleBids, settlePlacement, notifyBpayPayment) · `app/actions/alerts.ts` (ackAlert, addCustomAlert) |
| Portal layout on DAL/session | ✅ server `layout.tsx` fetches session + badges + alerts; interactivity in `PortalShell.tsx` (ack + sign-out call server actions) |
| Real auth (Supabase Auth + `proxy.ts` + RLS) | ⏳ planned — replaces the interim cookie bridge and the actor derived in `getActor()` |

> **Cut-over complete.** Every portal route now renders as a Server Component reading the Supabase DAL, all state mutations are Server Actions that write to Supabase + `audit_log` and revalidate the portal, and the shell reads the session. The legacy in-memory engine (`lib/db.ts`, `store/useDatabaseStore.ts`) is no longer imported by any route and is pending removal. The only remaining stage is swapping the interim session cookie for real Supabase Auth + RLS.
