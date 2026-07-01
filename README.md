# Vitti Capital - Client & Adviser Dashboard

Vitti Capital is a production-grade, stateful Next.js App Router application written in TypeScript and styled with Tailwind CSS v4. It mirrors the exact visual style and dual-workspace architecture of the single-file prototype (`vitti-capital-platform.html`).

> **Migration status:** the app is being moved from a purely in-memory prototype (Zustand + `lib/db.ts`) to a **Supabase (PostgreSQL) backend**. A data-access layer, a session-cookie bridge, and real per-client login are in place, and several routes now render as Server Components reading live data. The remaining routes still run on the legacy Zustand store during the incremental cut-over — see the [migration status](#5-supabase-migration-status).

---

## 1. Document Directory
Detailed design information is available under the `docs` folder:
* **[High-Level Design (HLD)](docs/HLD.md):** Platform structure, the Supabase persistence + data-access layer, the session bridge, dual-workspace flows, and responsive layout.
* **[Low-Level Design (LLD)](docs/LLD.md):** Data interfaces, the production SQL schema + interface→table mapping, the DAL / session / compute modules, state-mutation algorithms, and UI-chart math.
* **[Requirements](docs/REQUIREMENTS.md):** Prototype → production requirements, chosen providers, and behaviour flow charts.
* **[Production SQL Schema](db/schema.sql):** Portable PostgreSQL DDL (Supabase / Neon / Aurora); also applied as the first Supabase migration.

---

## 2. Directory Structure

Routes marked ✅ have been migrated to Server Components reading the Supabase DAL; the rest still run on the legacy Zustand store.

```bash
client-dashboard/
├── app/
│   ├── globals.css             # Tailwind v4 theme definitions and custom components
│   ├── layout.tsx              # Root Layout loading Google fonts
│   ├── page.tsx                # Landing / role selector
│   ├── actions/
│   │   └── session.ts          # Server actions: signIn / setViewClient / signOut (session cookie)
│   ├── login/
│   │   └── page.tsx            # Email login (resolves client) + 2FA; writes the session cookie
│   └── portal/
│       ├── layout.tsx          # Portal shell: sidebar, bottom-bar nav, "More" menu, alerts drawer (Zustand — pending)
│       ├── client/             # Client views
│       │   ├── page.tsx        #   Dashboard / Home
│       │   ├── invest/         #   ✅ page.tsx (server) + InvestClient.tsx (island) + discovery config
│       │   ├── positions/      #   ✅ page.tsx (server) + PositionsClient.tsx (donut/analytics island)
│       │   ├── insights/       #   ✅ page.tsx (server — signals, sectors, news, research)
│       │   ├── askvitti/       #   Ask Vitti AI chat
│       │   ├── markets/        #   ✅ page.tsx (server) + AlertButton.tsx (island)
│       │   ├── placements/     #   Bidding workspace (capital raises)
│       │   ├── options/        #   Options desk overview
│       │   ├── watchlist/      #   Watchlist & custom price alerts
│       │   └── alerts/         #   Alerts log
│       └── staff/              # Staff/Adviser views
│           ├── page.tsx        #   Overview / desk summary
│           ├── clients/        #   ✅ page.tsx (server) + ClientsTable.tsx (row-nav island)
│           │   └── [id]/       #   Client detail (expiry urgency rail)
│           ├── placements/     #   Deal book manager (scaling & settlement)
│           ├── options/        #   Firm-wide options monitor
│           ├── alerts/         #   Alerts log
│           └── audit/          #   ✅ page.tsx (server) + ExportButton.tsx (island)
├── lib/
│   ├── db.ts                   # Legacy in-memory DB (Zustand source; still powers unmigrated pages)
│   ├── fonts.ts                # next/font loader configurations
│   ├── session.ts              # Session-cookie read helpers: getSession / getActiveClientId
│   ├── supabase/
│   │   ├── client.ts           # Browser Supabase client (@supabase/ssr)
│   │   ├── server.ts           # Server Supabase client (async cookies)
│   │   └── database.types.ts   # Generated DB types (supabase gen types)
│   └── data/
│       ├── queries.ts          # Data-access layer (read side) — server-only
│       ├── compute.ts          # Pure financial helpers over DAL shapes (client-safe)
│       └── discovery.ts        # Static /invest goal + theme config (not persisted)
├── store/
│   └── useDatabaseStore.ts     # Zustand store (legacy; being phased out)
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
- **Session bridge:** an interim cookie (`{ role, clientId, viewClient }`) written by `app/actions/session.ts` and read via `lib/session.ts` — real Supabase Auth + RLS will later replace the cookie read with `getUser()`.
- **Styling:** Tailwind CSS v4 with custom post-css and raw theme bindings inside `app/globals.css`.
- **Fonts:** `Fraunces` (serif accent headers), `Hanken Grotesk` (clean sans body text), and `IBM Plex Mono` (financial figures and metrics).
- **Legacy state engine:** the in-memory **Zustand** store (`useDatabaseStore.ts`) still powers routes not yet migrated; it is being phased out in favour of the DAL.
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
| Migrated routes | ✅ markets, positions, insights, invest (client) · clients, audit (staff) |
| Pending routes | ⏳ dashboard, options, watchlist, alerts, placements, askvitti; staff overview, clients/[id], options, placements, alerts |
| Mutations → server actions | ⏳ placeBid, scaleBids, settlement, ackAlert, addCustomAlert, BPAY (still Zustand) |
| Portal layout on DAL/session | ⏳ still Zustand (nav badges, alerts drawer, sign-out) |
| Real auth (Supabase Auth + `proxy.ts` + RLS) | ⏳ planned — replaces the cookie bridge |
