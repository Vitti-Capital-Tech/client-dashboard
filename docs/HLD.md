# High-Level Design (HLD) - Vitti Capital Platform

## 1. Project Overview & Objectives
The Vitti Capital Platform is a structured, production-ready Next.js application ported from a single-file HTML prototype (`vitti-capital-platform.html`). It serves as a mock broker dashboard and client desk for high-net-worth (wholesale) clients.

The objectives of the platform are:
- **High Fidelity UI:** Mirroring the aesthetic language of the original mock-up, including custom typography (Fraunces, Hanken Grotesk, IBM Plex Mono), HSL colors (navy, green, paper, etc.), custom option expiry urgency rails, and moneyness bars.
- **Simulated Real-World Functions:** Stateful operations for bidding on open capital raises, scaling allocations, acknowledging system/custom notifications, monitoring option expiration, and viewing transactional audit logs.
- **Dual-role Workspaces:** Dynamic interfaces tailored to **Clients** (portfolio valuation, placing placement bids, options overview, AI assistant) and **Staff/Advisers** (adviser registry, scaling back raises, updating deal stages, auditing trails).

---

## 2. Architecture Layout

<svg viewBox="0 0 900 450" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg">
  <style>
    .node { fill: #1e293b; stroke: #38bdf8; stroke-width: 2; rx: 6px; }
    .node-db { fill: #0f172a; stroke: #10b981; stroke-width: 2; rx: 6px; }
    .node-client { fill: #1e293b; stroke: #f59e0b; stroke-width: 2; rx: 6px; }
    .node-staff { fill: #1e293b; stroke: #ec4899; stroke-width: 2; rx: 6px; }
    .text { fill: #f8fafc; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; font-weight: 500; text-anchor: middle; dominant-baseline: middle; }
    .title { fill: #f8fafc; font-family: system-ui, -apple-system, sans-serif; font-size: 14px; font-weight: bold; text-anchor: middle; dominant-baseline: middle; }
    .edge { stroke: #64748b; stroke-width: 1.5; fill: none; marker-end: url(#arrow); }
  </style>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 2 L 10 5 L 0 8 z" fill="#64748b" />
    </marker>
  </defs>
  
  <!-- Connections -->
  <path class="edge" d="M 450 55 L 450 90" />
  
  <path class="edge" d="M 350 125 C 350 150, 150 145, 150 170" />
  <path class="edge" d="M 390 125 C 390 150, 310 145, 310 170" />
  <path class="edge" d="M 550 125 C 550 150, 600 145, 600 170" />
  
  <path class="edge" d="M 600 205 L 600 220 C 600 230 480 230 480 250" />
  <path class="edge" d="M 600 205 L 600 220 C 600 230 740 230 740 250" />
  
  <!-- Client Sub-pages -->
  <path class="edge" d="M 480 285 L 480 300 C 480 310 340 310 340 330" />
  <path class="edge" d="M 480 285 L 480 300 C 480 310 460 310 460 330" />
  <path class="edge" d="M 480 285 L 480 330" />
  <path class="edge" d="M 480 285 L 480 300 C 480 310 700 310 700 330" />
  <path class="edge" d="M 480 285 L 480 300 C 480 310 820 310 820 330" />

  <!-- Staff Sub-pages -->
  <path class="edge" d="M 740 285 L 740 360 C 740 370 600 370 600 390" />
  <path class="edge" d="M 740 285 L 740 360 C 740 370 720 370 720 390" />
  <path class="edge" d="M 740 285 L 740 360 C 740 370 840 370 840 390" />

  <!-- Nodes -->
  <rect class="node" x="360" y="20" width="180" height="35" />
  <text class="title" x="450" y="37.5">Root Layout</text>
  
  <rect class="node-db" x="320" y="90" width="260" height="35" />
  <text class="title" x="450" y="107.5">DatabaseProvider (Context State)</text>
  
  <rect class="node" x="80" y="170" width="140" height="35" />
  <text class="text" x="150" y="187.5">Landing Page (/)</text>
  
  <rect class="node" x="240" y="170" width="140" height="35" />
  <text class="text" x="310" y="187.5">Login Page (/login)</text>
  
  <rect class="node" x="510" y="170" width="180" height="35" />
  <text class="title" x="600" y="187.5">Portal Shell (/portal)</text>
  
  <rect class="node-client" x="400" y="250" width="160" height="35" />
  <text class="title" x="480" y="267.5">Client Views</text>
  
  <rect class="node-staff" x="660" y="250" width="160" height="35" />
  <text class="title" x="740" y="267.5">Staff Views</text>
  
  <!-- Client Pages -->
  <rect class="node" x="285" y="330" width="110" height="35" />
  <text class="text" x="340" y="347.5">Dashboard</text>
  
  <rect class="node" x="405" y="330" width="110" height="35" />
  <text class="text" x="460" y="347.5">Portfolio</text>
  
  <rect class="node" x="525" y="330" width="110" height="35" />
  <text class="text" x="580" y="347.5">Options Desk</text>
  
  <rect class="node" x="645" y="330" width="110" height="35" />
  <text class="text" x="700" y="347.5">Bids Workspace</text>
  
  <rect class="node" x="765" y="330" width="110" height="35" />
  <text class="text" x="820" y="347.5">Ask Vitti Chat</text>

  <!-- Staff Pages -->
  <rect class="node" x="545" y="390" width="110" height="35" />
  <text class="text" x="600" y="407.5">Client Register</text>
  
  <rect class="node" x="665" y="390" width="110" height="35" />
  <text class="text" x="720" y="407.5">Deals Manager</text>
  
  <rect class="node" x="785" y="390" width="110" height="35" />
  <text class="text" x="840" y="407.5">Audit Viewer</text>
</svg>

---

## 3. High-Level Components

### 3.1 Reactive State Store (`contexts/DatabaseContext.tsx`)
Because this is a self-contained prototype, database interactions are simulated in memory:
- An initial database object (`INITIAL_DATABASE`) is loaded from `lib/db.ts`.
- The database is wrapped in React state (`db`) inside the `DatabaseProvider`.
- Mutators copy the database and return updated versions with mutations (e.g., bid increments, allocation scales, custom price alerts).
- The state changes trigger reactively across all active pages (e.g., client placements update immediately when a staff member scales allocations).

### 3.2 Unified Shell Wrapper (`app/portal/layout.tsx`)
The wrapper coordinates:
- **Global Header (Topbar):** Status indicators, search bar, active user indicators, and global slide-out alerts drawer.
- **Desktop Sidebar:** Persistent left panel navigation.
- **Mobile Bottom Bar:** Navigational tabs for mobile view.
- **Alerts Slide-out Drawer:** Pull-out notification interface for acknowledging critical ITM and expiry warnings.

### 3.3 Responsive Web Layout
The portal layout is fully responsive natively using CSS media queries. On desktop viewports, it renders the left navigation sidebar. On mobile or tablet devices, it automatically hides the sidebar and renders a fixed bottom navigation bar (matching standard mobile app layouts), adjusting page margins to fit nicely.

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
