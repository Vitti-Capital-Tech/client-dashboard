# High-Level Design (HLD) - Vitti Capital Platform

## 1. Project Overview & Objectives
The Vitti Capital Platform is a structured, production-ready Next.js application ported from a single-file HTML prototype (`vitti-capital-platform.html`). It serves as a mock broker dashboard and client desk for high-net-worth (wholesale) clients.

The objectives of the platform are:
- **High Fidelity UI:** Mirroring the aesthetic language of the original mock-up, including custom typography (Fraunces, Hanken Grotesk, IBM Plex Mono), HSL colors (navy, green, paper, etc.), custom option expiry urgency rails, and moneyness bars.
- **Simulated Real-World Functions:** Stateful operations for bidding on open capital raises, scaling allocations, acknowledging system/custom notifications, monitoring option expiration, and viewing transactional audit logs.
- **Dual-role Workspaces:** Dynamic interfaces tailored to **Clients** (portfolio valuation, placing placement bids, options overview, AI assistant) and **Staff/Advisers** (adviser registry, scaling back raises, updating deal stages, auditing trails).

---

## 2. Architecture Layout

```mermaid
graph TD
    A["Root Layout (app/layout.tsx)"] --> B["Zustand Store (store/useDatabaseStore.ts)"]
    B --> C["Landing Page (app/page.tsx)"]
    B --> D["Login Page (app/login/page.tsx)"]
    B --> E["Portal Shell Layout (app/portal/layout.tsx)"]
    
    E --> F["Client Views (/portal/client)"]
    E --> G["Staff Views (/portal/staff)"]
    
    subgraph "State Store"
        B --> DB["Stateful Mock Database (lib/db.ts)"]
        DB -.->|"persistence model"| SQL["Production SQL Schema (db/schema.sql)"]
    end
    
    subgraph "Client Views"
        F --> F1["Dashboard / Home (/portal/client)"]
        F --> F2["Invest — goal-based ideas (/invest)"]
        F --> F3["Portfolio & Positions (/positions)"]
        F --> F4["Insights — signals & sectors (/insights)"]
        F --> F5["Ask Vitti AI Chat (/askvitti)"]
        F --> F6["Markets — indices & news (/markets)"]
        F --> F7["Bidding Workspace (/placements)"]
        F --> F8["Options Desk (/options)"]
        F --> F9["Watchlist & price alerts (/watchlist)"]
        F --> F10["Alerts log (/alerts)"]
    end
    
    subgraph "Staff Views"
        G --> G1["Overview / Desk summary (/portal/staff)"]
        G --> G2["Client Registry (/clients)"]
        G --> G3["Client Detail — expiry rail (/clients/[id])"]
        G --> G4["Deal Book Manager (/placements)"]
        G --> G5["Firm-wide Options Monitor (/options)"]
        G --> G6["Alerts log (/alerts)"]
        G --> G7["Audit Log Viewer (/audit)"]
    end
```

---

## 3. High-Level Components

### 3.1 Reactive State Store (`store/useDatabaseStore.ts`)
Because this is a self-contained prototype, database interactions are simulated in memory:
- An initial database object (`INITIAL_DATABASE`) is loaded from `lib/db.ts`. At store-init the alerts engine (`scanAlerts`) and audit seeder (`seedAudits`) run once to populate `db.alerts` and `db.audit`.
- The database is managed globally using a **Zustand** store (`useDatabaseStore`), which also tracks session context: `role` (`client | admin`), `clientId`, `viewClient` (the client a staff member is inspecting), and a derived `currentUserLabel` getter used to stamp audit entries.
- Mutators (`mutatePlaceBid`, `mutateWithdrawBid`, `mutateScaleBids`, `mutateUpdatePlacementStage`, `mutateAckAlert`, `mutateAddCustomAlert`, `mutateClientBpayPayment`) copy the database and return updated versions with mutations (e.g., bid increments, allocation scales, custom price alerts, BPAY payment flags).
- The state changes trigger reactively across all active pages via fine-grained slice selectors (e.g., client placements update immediately when a staff member scales allocations).

### 3.1a Production Persistence Model (`db/schema.sql`)
While the running app is in-memory, the repository ships a portable PostgreSQL schema (`db/schema.sql`) that defines the intended production persistence layer — runnable as-is on Supabase, Neon, or AWS Aurora. It normalizes the flat prototype objects into integrity-constrained relations: a shared `securities` price master, per-client `client_accounts` for cash, an append-only month-partitioned `audit_log`, and reference/content tables (signals, sectors, news, investment ideas, research reports). See the LLD for the full TypeScript-interface → SQL-table mapping and the deliberate divergences.

### 3.2 Unified Shell Wrapper (`app/portal/layout.tsx`)
The wrapper coordinates a single role-aware navigation config (`navItems.client` / `navItems.admin`) rendered across multiple surfaces:
- **Global Header (Topbar):** Live broker-feed status pill, illustrative search bar, active-user avatar, and the alerts toggle (with unread badge).
- **Desktop Sidebar:** Persistent left panel navigation showing all routes, the workspace label, the signed-in user card, and sign-out.
- **Mobile Bottom Bar:** Fixed bottom tab bar showing the primary (`tab: true`) routes.
- **"More" Overflow Menu:** A mobile modal exposing the secondary routes that don't fit the bottom bar.
- **Alerts Slide-out Drawer:** Pull-out notification interface for acknowledging critical ITM, expiry, exercise-window, and custom price warnings. Staff see firm-wide alerts; clients see only their own.
- **Badges:** The nav computes live badge counts — unread alerts, and (admin only) the count of closed-deal bids still awaiting allocation (`pendingAlloc`).

### 3.3 Responsive Web Layout
The portal layout is fully responsive natively using CSS media queries (Tailwind `md` breakpoint, 768px) — there is no device-frame emulator. On desktop viewports it renders the left navigation sidebar. On mobile or tablet devices it automatically hides the sidebar and renders a fixed bottom navigation bar plus the "More" overflow menu (matching standard mobile app layouts), adjusting page padding (`pb-16 md:pb-0`) so content is never covered by the bottom bar.

---

## 4. Key Architectural Flows

### 4.1 Bidding and Allocation Lifecycle
1. **Bid Placement:** Client visits `/portal/client/placements`, uses the bidding workspace to calculate costs, and submits a bid. A `Placed bid` audit entry is created.
2. **Book Close:** Staff member logs in, navigates to `/portal/staff/placements`, and changes the deal stage to "Closed".
3. **Allocation Scaling:** Staff uses the slider or manual inputs to scale back client allocations and hits "Scale & Commit". This updates `bids[i].alloc` values.
4. **Deal Settlement:** Staff transitions the deal stage to "Settled". The database automatically converts allocated bids into equity holdings (adding stocks to `db.positions` and attaching option sweeteners to `db.options`).
5. **Confirmation:** Client logs in, sees their dashboard performance updated, and views the placement status as "Allotment confirmed".

### 4.2 Expiry Alert Lifecycle
1. **Options Scan:** The engine scans options regularly.
2. **Alert Triggering:** If an option is within 30 days of expiry, or is in the money (ITM) and unlisted, it flags warnings.
3. **Desk Notice:** A slide-out alert notification is rendered.
4. **Acknowledgement:** Clicking "Ack" flags the alert as read, moving it down the priority list.
