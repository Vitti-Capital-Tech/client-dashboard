# Vitti Capital - Client & Adviser Dashboard

Vitti Capital is a production-grade, stateful Next.js App Router application written in TypeScript and styled with Tailwind CSS v4. It mirrors the exact visual style and dual-workspace architecture of the single-file prototype (`vitti-capital-platform.html`).

---

## 1. Document Directory
Detailed design information is available under the `docs` folder:
* **[High-Level Design (HLD)](docs/HLD.md):** Focuses on platform structure, mock DB state synchronization, dual-workspace workspaces, and device emulation.
* **[Low-Level Design (LLD)](docs/LLD.md):** Focuses on database schemas, state mutation algorithms, math formulas for UI charts, and layout styles.

---

## 2. Directory Structure

```bash
client-dashboard/
├── app/
│   ├── globals.css         # Tailwind v4 theme definitions and custom components
│   ├── layout.tsx          # Root Layout loading Google fonts and DB context
│   ├── page.tsx            # Main Landing / Role Selector
│   ├── login/
│   │   └── page.tsx        # Suspense-wrapped login interface with prefilled 2FA OTP
│   └── portal/
│       ├── layout.tsx      # Portals shell, bottom bar nav, alerts drawer, mobile emulator
│       ├── client/         # Client views (Dashboard, Portfolio, Options, Ask Vitti AI)
│       └── staff/          # Staff/Adviser views (Client Registry, Book Builder, Audits)
├── contexts/
│   └── DatabaseContext.tsx # Stateful mock database React Context provider
├── docs/
│   ├── HLD.md              # High-Level Architecture Design
│   └── LLD.md              # Low-Level Component Design
├── lib/
│   ├── db.ts               # Core database definitions, helper methods, mutations
│   └── fonts.ts            # next/font loader configurations
├── package.json
└── tsconfig.json
```

---

## 3. Technology Stack & Features

- **Framework:** Next.js 16 (App Router) & React 19 (Hooks, Suspense).
- **Styling:** Tailwind CSS v4 with custom post-css and raw theme bindings inside `app/globals.css`.
- **Fonts:** `Fraunces` (serif accent headers), `Hanken Grotesk` (clean sans body text), and `IBM Plex Mono` (financial figures and metrics).
- **State Engine:** Pure, reactively updated in-memory database context (`DatabaseContext.tsx`) syncing clients, position parameters, alerts logs, and audit entries.
- **Developer Features:** Instantly toggle between **Web Layout** (fluid responsive web design) and **Mobile Frame** (rendering layout components within a simulated smartphone device mockup frame).

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
Lint the code and compile the optimized static exports:
```bash
npm run lint
npm run build
```
The build produces statically pre-rendered HTML routes, confirming all TypeScript constraints and next bails compile cleanly.
