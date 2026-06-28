# Vitti Capital - Client & Adviser Dashboard

Vitti Capital is a production-grade, stateful Next.js App Router application written in TypeScript and styled with Tailwind CSS v4. It mirrors the exact visual style and dual-workspace architecture of the single-file prototype (`vitti-capital-platform.html`).

---

## 1. Document Directory
Detailed design information is available under the `docs` folder:
* **[High-Level Design (HLD)](docs/HLD.md):** Focuses on platform structure, mock DB state synchronization, dual-workspace workspaces, and responsive layout.
* **[Low-Level Design (LLD)](docs/LLD.md):** Focuses on data interfaces, the production SQL schema, state mutation algorithms, math formulas for UI charts, and layout styles.
* **[Production SQL Schema](db/schema.sql):** Portable PostgreSQL DDL (Supabase / Neon / Aurora) modelling the relational, persisted version of the in-memory prototype database.

---

## 2. Directory Structure

```bash
client-dashboard/
├── app/
│   ├── globals.css             # Tailwind v4 theme definitions and custom components
│   ├── layout.tsx              # Root Layout loading Google fonts and DB context
│   ├── page.tsx                # Main Landing / Role Selector
│   ├── login/
│   │   └── page.tsx            # Suspense-wrapped login interface with prefilled 2FA OTP
│   └── portal/
│       ├── layout.tsx          # Portal shell: sidebar, bottom-bar nav, "More" menu, alerts drawer
│       ├── client/             # Client views (10 routes)
│       │   ├── page.tsx        #   Dashboard / Home
│       │   ├── invest/         #   Goal-based investment ideas
│       │   ├── positions/      #   Portfolio & positions (donut chart)
│       │   ├── insights/       #   Signals, sectors & research insights
│       │   ├── askvitti/       #   Ask Vitti AI chat
│       │   ├── markets/        #   Market indices & news strip
│       │   ├── placements/     #   Bidding workspace (capital raises)
│       │   ├── options/        #   Options desk overview
│       │   ├── watchlist/      #   Watchlist & custom price alerts
│       │   └── alerts/         #   Alerts log
│       └── staff/              # Staff/Adviser views (7 routes)
│           ├── page.tsx        #   Overview / desk summary
│           ├── clients/        #   Client registry
│           │   └── [id]/       #   Client detail (expiry urgency rail)
│           ├── placements/     #   Deal book manager (scaling & settlement)
│           ├── options/        #   Firm-wide options monitor
│           ├── alerts/         #   Alerts log
│           └── audit/          #   Audit log viewer
├── store/
│   └── useDatabaseStore.ts     # Zustand global state management
├── docs/
│   ├── HLD.md                  # High-Level Architecture Design
│   └── LLD.md                  # Low-Level Component Design
├── db/
│   └── schema.sql              # Production PostgreSQL schema (relational persistence model)
├── lib/
│   ├── db.ts                   # Data interfaces, seed DB, helpers, alert engine, mutations
│   └── fonts.ts                # next/font loader configurations
├── vitti-capital-platform.html # Original single-file prototype (visual source of truth)
├── next.config.ts
├── eslint.config.mjs
├── postcss.config.mjs
├── package.json
└── tsconfig.json
```

---

## 3. Technology Stack & Features

- **Framework:** Next.js 16 (App Router) & React 19 (Hooks, Suspense).
- **Styling:** Tailwind CSS v4 with custom post-css and raw theme bindings inside `app/globals.css`.
- **Fonts:** `Fraunces` (serif accent headers), `Hanken Grotesk` (clean sans body text), and `IBM Plex Mono` (financial figures and metrics).
- **State Engine:** Pure, reactively updated in-memory database using **Zustand** (`useDatabaseStore.ts`) syncing clients, position parameters, alerts logs, and audit entries.
- **Responsive Shell:** A single portal shell adapts natively across breakpoints — a persistent left sidebar on desktop (`md`+) collapses to a fixed bottom navigation bar plus a "More" overflow menu on mobile/tablet viewports (no device-frame emulator; pure CSS responsiveness).
- **Production Schema:** A portable PostgreSQL DDL (`db/schema.sql`) mirrors the in-memory prototype as a normalized, integrity-constrained relational model ready for Supabase / Neon / Aurora.

---

## 4. Getting Started

### 4.1 Installation
Install project dependencies:
```bash
npm install
```

### 4.2 Run Development Server
Start the local Next.js development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) inside your web browser.

### 4.3 Production Build & Verification
Lint the code and compile the optimized production bundle:
```bash
npm run lint
npm run build
```
The portal pages are interactive client components (`"use client"`), so the build emits a mix of pre-rendered shells and client-rendered routes rather than a fully static export. A clean build confirms all TypeScript constraints are satisfied and that any `useSearchParams()` Suspense boundaries (see `app/login/page.tsx`) compile without CSR bailout errors.
