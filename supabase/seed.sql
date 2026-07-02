-- ============================================================================
-- Vitti Capital — demo seed data
-- ----------------------------------------------------------------------------
-- Ports lib/db.ts INITIAL_DATABASE into the normalized schema.
--   • Prices live once in `securities` (positions/options join, never duplicate).
--   • Option `dte` becomes a real `expiry_date` = anchor date + dte.
--   • Legacy ids (C1/P1/O1…) live in `ref`; FKs resolve via sub-selects.
--   • `alerts` are NOT seeded — they are derived by the alert engine at runtime.
-- Anchor "today" for the dataset: 2026-06-12 (matches lib/db.ts TODAY).
-- Re-runnable: truncates the data tables first (schema is untouched).
-- Apply via the Supabase SQL Editor, or: psql "$DATABASE_URL" -f supabase/seed.sql
-- ============================================================================

BEGIN;

TRUNCATE securities, market_indices, clients, placements, sectors, news,
         investment_ideas, research_reports, research_notes, signals,
         recommendations, audit_log
  RESTART IDENTITY CASCADE;

-- ----------------------------------------------------------------------------
-- Market master data
-- ----------------------------------------------------------------------------
INSERT INTO securities (code, name, sector, listed, last_price, last_price_at) VALUES
  ('BHP', 'BHP Group',              'Materials',              true,  44.1800, '2026-06-12 16:00:00+10'),
  ('CSL', 'CSL Limited',            'Health care',            true, 299.3000, '2026-06-12 16:00:00+10'),
  ('PLS', 'Pilbara Minerals',       'Materials',              true,   3.8400, '2026-06-12 16:00:00+10'),
  ('WES', 'Wesfarmers',             'Consumer',               true,  78.9200, '2026-06-12 16:00:00+10'),
  ('CBA', 'Commonwealth Bank',      'Financials',             true, 132.4000, '2026-06-12 16:00:00+10'),
  ('WDS', 'Woodside Energy',        'Energy',                 true,  26.4000, '2026-06-12 16:00:00+10'),
  ('MQG', 'Macquarie Group',        'Financials',             true, 214.5000, '2026-06-12 16:00:00+10'),
  ('FMG', 'Fortescue',              'Materials',              true,  22.4100, '2026-06-12 16:00:00+10'),
  -- Option underlyings (code = option code minus trailing "O")
  ('VEX', 'Vertex Gold',            'Materials',              true,   0.5200, '2026-06-12 16:00:00+10'),
  ('MRD', 'Meridian Resources',     'Materials',              true,   0.5900, '2026-06-12 16:00:00+10'),
  ('HLX', 'Helios Energy',          'Energy',                 true,   2.0000, '2026-06-12 16:00:00+10'),
  ('NVX', 'Novonix',                'Materials',              true,   0.9100, '2026-06-12 16:00:00+10'),
  ('ZPC', 'Zip Co',                 'Financials',             true,   1.2800, '2026-06-12 16:00:00+10'),
  ('AUR', 'Aurora Biotech',         'Health care',            false,  1.2000, '2026-06-12 16:00:00+10'),
  ('LTR', 'Liontown Resources',     'Materials',              true,   1.0600, '2026-06-12 16:00:00+10'),
  ('CXO', 'Core Lithium',           'Materials',              true,   0.1800, '2026-06-12 16:00:00+10'),
  ('BRN', 'Brainchip',              'Information Technology',  true,   0.2400, '2026-06-12 16:00:00+10'),
  ('TLX', 'Telix Pharmaceuticals',  'Health care',            true,  14.2000, '2026-06-12 16:00:00+10');

INSERT INTO market_indices (code, name, last, chg, decimal_places) VALUES
  ('XJO',    'S&P/ASX 200',   8412.3000,  0.6100, 1),
  ('XKO',    'ASX 300',       8327.1000,  0.5800, 1),
  ('XSO',    'Small Ords',    3261.8000,  0.9200, 1),
  ('AUDUSD', 'AUD / USD',        0.6712, -0.1200, 4),
  ('XAU',    'Gold (USD/oz)', 2418.0000,  0.4000, 0),
  ('BRENT',  'Brent crude',     81.2200, -1.1000, 1);

-- ----------------------------------------------------------------------------
-- Clients & accounts
-- ----------------------------------------------------------------------------
-- Clients are now just the person/login (account_type + s708 moved to accounts).
INSERT INTO clients (ref, email, display_name, initials) VALUES
  ('C1', 'james@halloran.com.au',     'James Halloran',          'JH'),
  ('C2', 'margaret.chen@outlook.com', 'Margaret Chen',           'MC'),
  ('C3', 'office@endeavourfo.com.au', 'Endeavour Family Office', 'EF'),
  ('C4', 'david.okafor@gmail.com',    'David Okafor',            'DO');

-- Investment accounts. C1 (James) holds TWO accounts to exercise multi-account;
-- the others hold one each. account_type + s708 + cash live here now.
INSERT INTO accounts (ref, client_id, label, account_type, s708_expiry, cash_balance, currency) VALUES
  ('A1', (SELECT id FROM clients WHERE ref='C1'), 'Personal',     'Individual · wholesale', '2027-03-01', 100000.00, 'AUD'),
  ('A2', (SELECT id FROM clients WHERE ref='C1'), 'Halloran SMSF','SMSF · wholesale',       '2027-03-01',  28450.00, 'AUD'),
  ('A3', (SELECT id FROM clients WHERE ref='C2'), 'Personal',     'Individual · wholesale', '2026-08-01',  64200.00, 'AUD'),
  ('A4', (SELECT id FROM clients WHERE ref='C3'), 'Endeavour FO', 'Family office',          '2028-01-01', 540000.00, 'AUD'),
  ('A5', (SELECT id FROM clients WHERE ref='C4'), 'Okafor SMSF',  'SMSF · wholesale',       '2026-11-01',  38900.00, 'AUD');

-- ----------------------------------------------------------------------------
-- Equity positions (name/sector/last join from securities)
-- ----------------------------------------------------------------------------
-- account_id is the real scope; client_id kept (denormalized owner). C1's
-- holdings are split across A1 (Personal) and A2 (SMSF).
INSERT INTO positions (account_id, client_id, security_code, qty, avg_cost) VALUES
  ((SELECT id FROM accounts WHERE ref='A1'), (SELECT id FROM clients WHERE ref='C1'), 'BHP',  2100.0000,  38.4000),
  ((SELECT id FROM accounts WHERE ref='A1'), (SELECT id FROM clients WHERE ref='C1'), 'CSL',   240.0000, 285.0000),
  ((SELECT id FROM accounts WHERE ref='A2'), (SELECT id FROM clients WHERE ref='C1'), 'PLS', 21400.0000,   3.1000),
  ((SELECT id FROM accounts WHERE ref='A2'), (SELECT id FROM clients WHERE ref='C1'), 'WES',  1050.0000,  64.2000),
  ((SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'), 'CBA',   600.0000, 104.1000),
  ((SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'), 'BHP',  1400.0000,  41.1000),
  ((SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'), 'WDS',  2200.0000,  29.6000),
  ((SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 'BHP',  8200.0000,  36.9000),
  ((SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 'CSL',  1100.0000, 270.4000),
  ((SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 'MQG',   900.0000, 178.2000),
  ((SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 'PLS', 60000.0000,   3.5500),
  ((SELECT id FROM accounts WHERE ref='A5'), (SELECT id FROM clients WHERE ref='C4'), 'FMG',  3400.0000,  24.8000),
  ((SELECT id FROM accounts WHERE ref='A5'), (SELECT id FROM clients WHERE ref='C4'), 'CBA',   300.0000,  98.0000);

-- ----------------------------------------------------------------------------
-- Option holdings (expiry_date = 2026-06-12 + dte; underlying price via securities)
-- ----------------------------------------------------------------------------
INSERT INTO option_holdings
  (ref, account_id, client_id, code, name, listed, option_type, qty, strike, underlying_code, expiry_date, source, status) VALUES
  ('O1',  (SELECT id FROM accounts WHERE ref='A1'), (SELECT id FROM clients WHERE ref='C1'), 'VEXO', 'Vertex Gold options',        true,  'Call', 15000.0000,  0.4500, 'VEX', DATE '2026-06-12' + 202, 'SPP Apr 26',           'open'),
  ('O2',  (SELECT id FROM accounts WHERE ref='A1'), (SELECT id FROM clients WHERE ref='C1'), 'MRDO', 'Meridian Resources options', false, 'Call',     0.0000,  0.7500, 'MRD', DATE '2026-06-12' + 735, 'Placement attaching',  'pending'),
  ('O3',  (SELECT id FROM accounts WHERE ref='A2'), (SELECT id FROM clients WHERE ref='C1'), 'HLXO', 'Helios Energy options',      false, 'Call', 30000.0000,  2.5000, 'HLX', DATE '2026-06-12' + 657, 'Series B sweetener',   'open'),
  ('O4',  (SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'), 'NVXO', 'Novonix options',            true,  'Call', 40000.0000,  0.8000, 'NVX', DATE '2026-06-12' + 5,   'Rights issue',         'open'),
  ('O5',  (SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'), 'ZPCO', 'Zip Co options',             true,  'Call', 12000.0000,  1.4000, 'ZPC', DATE '2026-06-12' + 27,  'Listed market',        'open'),
  ('O6',  (SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 'AURO', 'Aurora Biotech options',     false, 'Call', 50000.0000,  1.0000, 'AUR', DATE '2026-06-12' + 3,   'Pre-IPO note',         'open'),
  ('O7',  (SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 'LTRO', 'Liontown options',           true,  'Call', 25000.0000,  1.2000, 'LTR', DATE '2026-06-12' + 88,  'Listed market',        'open'),
  ('O8',  (SELECT id FROM accounts WHERE ref='A5'), (SELECT id FROM clients WHERE ref='C4'), 'CXOO', 'Core Lithium options',       false, 'Call', 80000.0000,  0.1500, 'CXO', DATE '2026-06-12' + 1,   'Placement attaching',  'open'),
  ('O9',  (SELECT id FROM accounts WHERE ref='A5'), (SELECT id FROM clients WHERE ref='C4'), 'BRNO', 'Brainchip options',          true,  'Call', 30000.0000,  0.3000, 'BRN', DATE '2026-06-12' + 14,  'Listed market',        'open'),
  ('O10', (SELECT id FROM accounts WHERE ref='A2'), (SELECT id FROM clients WHERE ref='C1'), 'TLXO', 'Telix options (expired)',    true,  'Call', 10000.0000, 18.0000, 'TLX', DATE '2026-06-12' - 9,   'Listed market',        'expired');

-- ----------------------------------------------------------------------------
-- Placements & bids
-- ----------------------------------------------------------------------------
INSERT INTO placements
  (ref, code, name, type, price, last, discount_pct, raise_millions, min_bid, opts, stage, close_date, alloc_date, settle_date, allot_date) VALUES
  ('P1', 'MRD', 'Meridian Resources', 'Placement', 0.5000, 0.5900, 15.3000, 12.00, 10000.00, '1 free option (1:2)', 'open',     DATE '2026-06-12',      DATE '2026-06-12' + 3,  DATE '2026-06-12' + 6,  DATE '2026-06-12' + 7),
  ('P2', 'TTM', 'Tectonic Metals',    'Placement', 0.5000, 0.5100, 12.0000,  8.00, 10000.00, 'None',                'closed',   DATE '2026-06-12' - 1,  DATE '2026-06-12',      DATE '2026-06-12' + 4,  DATE '2026-06-12' + 5),
  ('P3', 'AUR', 'Aurora Biotech',     'Pre-IPO',   1.2000, NULL,   NULL,     25.00, 25000.00, '1 free option (1:1)', 'upcoming', DATE '2026-06-12' + 5,  DATE '2026-06-12' + 8,  DATE '2026-06-12' + 11, DATE '2026-06-12' + 12),
  ('P4', 'VEX', 'Vertex Gold',        'SPP',       0.4200, 0.5100, 17.6000,  3.00,  5000.00, '1 free option (1:3)', 'settled',  DATE '2026-06-12' - 40, DATE '2026-06-12' - 38, DATE '2026-06-12' - 35, DATE '2026-06-12' - 34);

INSERT INTO bids (placement_id, account_id, client_id, amount, alloc, paid) VALUES
  ((SELECT id FROM placements WHERE ref='P1'), (SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'),  60000.00,     NULL, false),
  ((SELECT id FROM placements WHERE ref='P1'), (SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'), 150000.00,     NULL, false),
  ((SELECT id FROM placements WHERE ref='P2'), (SELECT id FROM accounts WHERE ref='A1'), (SELECT id FROM clients WHERE ref='C1'),  40000.00,     NULL, false),
  ((SELECT id FROM placements WHERE ref='P2'), (SELECT id FROM accounts WHERE ref='A3'), (SELECT id FROM clients WHERE ref='C2'),  25000.00,     NULL, false),
  ((SELECT id FROM placements WHERE ref='P2'), (SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'),  80000.00,     NULL, false),
  ((SELECT id FROM placements WHERE ref='P2'), (SELECT id FROM accounts WHERE ref='A5'), (SELECT id FROM clients WHERE ref='C4'),  30000.00,     NULL, false),
  ((SELECT id FROM placements WHERE ref='P4'), (SELECT id FROM accounts WHERE ref='A1'), (SELECT id FROM clients WHERE ref='C1'),  15000.00, 15000.00, true),
  ((SELECT id FROM placements WHERE ref='P4'), (SELECT id FROM accounts WHERE ref='A4'), (SELECT id FROM clients WHERE ref='C3'),  20000.00, 20000.00, true);

-- ----------------------------------------------------------------------------
-- Watchlists (security_code has no FK — unlisted allowed)
-- ----------------------------------------------------------------------------
INSERT INTO watchlist_items (client_id, security_code, display_name, alert_threshold, alert_direction, unlisted) VALUES
  ((SELECT id FROM clients WHERE ref='C1'), 'MRD', 'Meridian Resources', 0.6000, 'above', false),
  ((SELECT id FROM clients WHERE ref='C1'), 'PLS', 'Pilbara Minerals',   NULL,    NULL,   false),
  ((SELECT id FROM clients WHERE ref='C1'), 'NVX', 'Novonix',            0.8500, 'below', false),
  ((SELECT id FROM clients WHERE ref='C1'), 'FMG', 'Fortescue',          NULL,    NULL,   false),
  ((SELECT id FROM clients WHERE ref='C1'), 'LTR', 'Liontown',           NULL,    NULL,   false),
  ((SELECT id FROM clients WHERE ref='C1'), 'AUR', 'Aurora Biotech',     NULL,    NULL,   true),
  ((SELECT id FROM clients WHERE ref='C2'), 'CBA', 'Commonwealth Bank', 135.0000, 'above', false),
  ((SELECT id FROM clients WHERE ref='C2'), 'WDS', 'Woodside',           NULL,    NULL,   false),
  ((SELECT id FROM clients WHERE ref='C3'), 'MQG', 'Macquarie',          NULL,    NULL,   false),
  ((SELECT id FROM clients WHERE ref='C3'), 'BHP', 'BHP Group',         46.0000, 'above', false),
  ((SELECT id FROM clients WHERE ref='C4'), 'FMG', 'Fortescue',         22.5000, 'below', false);

-- ----------------------------------------------------------------------------
-- Research / content
-- ----------------------------------------------------------------------------
INSERT INTO signals (security_code, action, headline, detail, target) VALUES
  ('BHP', 'Add',         'Iron ore firm on China stimulus; copper optionality building', $t$Trading inside our entry band with near-term support from Chinese stimulus and a structural copper bid from electrification. We’d add on any weakness toward $42.$t$, 49.5000),
  ('CSL', 'Add',         'Plasma margins recovering into an undemanding valuation',       $t$Collection costs are normalising and immunoglobulin demand is durable. The de-rating has gone too far for the quality; we see re-rating room toward $330.$t$, 330.0000),
  ('PLS', 'Hold',        'Lithium leverage — wait for confirmation above $3.90',          $t$Low-cost spodumene leaves PLS well placed for the next up-cycle, but the price is volatile. Hold existing exposure; add only on a confirmed break of the entry ceiling.$t$, 4.8000),
  ('WES', 'Hold',        'Quality compounder — let it run toward target',                $t$Bunnings keeps taking share and capital allocation is disciplined. Core income holding; no action needed below $88.$t$, 88.0000),
  ('WDS', 'Trim',        'Energy soft — rotate into higher-conviction names',            $t$Oil is under pressure on demand worries and a gas glut. We’d lighten energy here and redeploy toward materials or financials.$t$, NULL),
  ('CBA', 'Take profit', 'Above our fair value — consider trimming',                    $t$CBA trades richly versus the sector on most metrics. Banking the gain and rotating to MQG offers better risk/reward.$t$, NULL),
  ('MQG', 'Add',         'Fee momentum rebuilding; sits below our target',              $t$Annuity-style asset management plus a recovery in deal activity and green infrastructure should rebuild performance fees. Attractive below $218.$t$, 228.0000),
  ('FMG', 'Watch',       'Pure iron-ore leverage — wait for entry near $21',            $t$High-beta to the iron ore price with a generous but cyclical yield. We’d wait for a better entry rather than chase here.$t$, NULL);

INSERT INTO recommendations (security_code, rating, target_price, move) VALUES
  ('MRD', 'Spec buy', 0.7800,   '+3.5%'),
  ('BHP', 'Buy',     49.5000,   '+0.8%'),
  ('CSL', 'Hold',   305.0000,   '-0.4%'),
  ('AUR', 'Spec buy', NULL,     'pre-IPO'),
  ('MQG', 'Buy',    228.0000,   '+1.1%');

INSERT INTO sectors (name, momentum, drivers, beneficiaries) VALUES
  ('Resources & materials', 4.2000, 'China stimulus + structural lithium and copper deficits', ARRAY['BHP','PLS','FMG']),
  ('Technology & AI',       3.4000, 'AI data-centre capex cycle lifting compute and power demand', ARRAY[]::text[]),
  ('Financials',            1.1000, 'Rate plateau, buybacks and rebuilding deal flow', ARRAY['CBA','MQG']),
  ('Health care',           0.6000, 'Defensive bid and plasma-margin recovery', ARRAY['CSL']),
  ('Energy',               -1.8000, 'Soft oil demand and ample gas supply', ARRAY['WDS']);

INSERT INTO news (ts, source, headline, impact, direction, use_note) VALUES
  ('2026-06-12 06:40:00+10', 'Beijing',    'China unveils fresh stimulus targeting property and infrastructure', 'Materials ↑',        'up', $t$Direct tailwind for iron ore and base metals — supports BHP and PLS. Consider adding materials on dips rather than chasing strength.$t$),
  ('2026-06-12 05:10:00+10', 'Washington', 'US CPI comes in cooler than expected; rate-cut odds rise',           'Rates ↓ · Growth ↑', 'up', $t$A lower-for-longer path supports growth equities and gold. Constructive for MQG and resources; a reason to deploy idle cash steadily.$t$),
  ('2026-06-11 17:00:00+10', 'Global',     'Brent slides below $82 on demand concerns',                          'Energy ↓',           'dn', $t$Headwind for energy names — we’d trim WDS and rotate the proceeds into higher-conviction materials or financials.$t$),
  ('2026-06-11 16:00:00+10', 'US',         'Hyperscalers lift AI data-centre capex guidance again',              'Tech / Copper ↑',    'up', $t$Reinforces the copper demand story (BHP) and a structural AI theme that most Australian portfolios under-own — worth a strategic position.$t$);

INSERT INTO investment_ideas
  (code, name, theme, risk, horizon, conviction, entry_lo, entry_hi, target, hook, thesis, placement_id) VALUES
  ('BHP', 'BHP Group',          'Blue chips',      'Low',    '12 months',    3, 42.0000, 45.5000, 49.5000, $t$The world’s biggest miner, at a fair price$t$,        $t$BHP pairs low-cost iron ore with growing copper exposure as electrification demand builds. A strong balance sheet funds a reliable dividend while the company invests through the cycle. Recent China stimulus supports near-term prices. We see a steady re-rate toward our target with limited downside for a portfolio anchor.$t$, NULL),
  ('WES', 'Wesfarmers',         'Income',          'Low',    '12–18 months', 3, 70.0000, 80.0000, 88.0000, $t$Bunnings-led quality compounder with a steady yield$t$, $t$Wesfarmers owns category-leading retail (Bunnings, Kmart) that keeps taking share, plus optionality in lithium and healthcare. Defensive earnings and disciplined capital allocation support a dependable, growing dividend. We like it as a core income holding that still offers capital growth over time.$t$, NULL),
  ('MQG', 'Macquarie Group',    'Income',          'Medium', '12 months',    2, 205.0000, 218.0000, 228.0000, $t$Global franchise with rising asset-management fees$t$, $t$Macquarie blends annuity-style asset management with leverage to a recovery in deal activity and green infrastructure. The dividend is solid and partially franked. As markets normalise, performance fees and advisory income should rebuild, supporting both the payout and the share price.$t$, NULL),
  ('PLS', 'Pilbara Minerals',   'Resources',       'High',   '18–24 months', 2, 3.5000, 3.9000, 4.8000, $t$Lowest-cost lithium leverage to the next up-cycle$t$,   $t$Pilbara is a low-cost, tier-one spodumene producer expanding capacity into a structural lithium deficit forming from 2027. The price is volatile and tied to the lithium cycle, so size it as a satellite. For investors who want direct exposure to the energy-transition theme, this is our preferred name.$t$, NULL),
  ('MRD', 'Meridian Resources', 'Pre-IPO & deals', 'High',   '2–3 years',    2, 0.5000, 0.6000, 0.7800, $t$Live placement — buy in at a 15% discount today$t$,     $t$Meridian is drilling a promising, under-explored corner of the Pilbara. A live placement lets you buy at $0.50, a 15% discount to market, with a free attaching option for extra upside. Speculative and pre-revenue, so size small, but the risk/reward on a discovery is compelling.$t$, (SELECT id FROM placements WHERE ref='P1')),
  ('AUR', 'Aurora Biotech',     'Pre-IPO & deals', 'High',   '3+ years',     2, NULL,   NULL,   NULL,    $t$Pre-IPO access before it lists$t$,                      $t$Aurora is a clinical-stage biotech approaching a planned ASX listing. Our pre-IPO allocation lets wholesale clients invest at $1.20 before public markets. Binary on trial outcomes and illiquid until listing, so this is for risk-tolerant capital seeking asymmetric, early-stage upside.$t$, (SELECT id FROM placements WHERE ref='P3')),
  ('CSL', 'CSL Limited',        'Blue chips',      'Low',    '18 months',    3, 285.0000, 305.0000, 330.0000, $t$World-class healthcare compounder on sale$t$,        $t$CSL is a global leader in blood plasma therapies and vaccines with durable demand and widening margins as collection costs normalise. After a period of underperformance the valuation is undemanding for the quality. A high-conviction defensive growth holding for patient capital.$t$, NULL);

INSERT INTO research_reports (title, kind, published, pages) VALUES
  ($t$Lithium — supply deficit widens into 2027$t$,               'Sector note',  DATE '2026-06-12' - 1, 12),
  ($t$MRD initiation — drilling the Pilbara’s quiet corner$t$,     'Company note', DATE '2026-06-12' - 3, 18),
  ($t$Mid-year strategy — positioning for a lower-rate world$t$,   'Strategy',     DATE '2026-06-12' - 6, 24);

INSERT INTO research_notes (title, body, published) VALUES
  ('RBA holds at 3.85%; miners firm on China stimulus',
   $t$Futures point the XJO up 0.4% at the open after the RBA left rates on hold and Chinese stimulus lifted iron ore. Lithium names are in focus ahead of the MRD book close at 4:00pm. We stay constructive on quality materials and selectively on pre-IPO resources exposure.$t$,
   '2026-06-12 07:42:00+10');

-- ----------------------------------------------------------------------------
-- Audit log seed (append-only; client actions link to clients via client_id)
-- ----------------------------------------------------------------------------
INSERT INTO audit_log (ts, actor, role, action, detail, client_id) VALUES
  ('2026-06-12 09:41:00+10', 'S. Goyal (staff)', 'admin',  'Signed in',     'Vitti staff console · 2FA verified', NULL),
  ('2026-06-12 09:31:00+10', 'James Halloran',   'client', 'Placed bid',    'MRD · $25,000 (client portal)',      (SELECT id FROM clients WHERE ref='C1')),
  ('2026-06-12 09:16:00+10', 'S. Goyal (staff)', 'admin',  'Uploaded note', 'MRD initiation note published',      NULL),
  ('2026-06-12 05:41:00+10', 'Margaret Chen',    'client', 'Signed in',     'Client portal · 2FA verified',       (SELECT id FROM clients WHERE ref='C2')),
  ('2026-06-11 09:41:00+10', 'System',           'system', 'Alert trigger', 'NVXO expiry warning (5d left)',      NULL);

COMMIT;
