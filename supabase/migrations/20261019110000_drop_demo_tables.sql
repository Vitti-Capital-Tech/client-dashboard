-- ============================================================================
-- Drop the demo reference tables
-- ============================================================================
-- These were created by the initial schema for the client portal's mock-up and
-- were only ever filled by demo seed data. Nothing in the broker, tracker or
-- ASX pipelines writes them, and on 19 October 2026 every one was empty. The
-- screens that read them showed nothing live, so they have been taken out of
-- the code along with this:
--
--   market_indices     dashboard index ticker, Markets page
--   signals            "desk view" pill on holdings, dashboard trim suggestion
--   sectors            Market page sector momentum
--   news               Market page news card
--   investment_ideas   Invest plan builder (the page remains, with no ideas)
--   recommendations    Markets page, watchlist placeholder price
--   research_reports   Market and Markets pages
--   research_notes     Markets page morning note
--
-- A real feature that needs any of these gets a table designed for its real
-- source, rather than inheriting a demo shape.
--
-- ── Apply this AFTER the code that stopped reading them is deployed ──────────
-- The other way round, every page above fails on a missing table until the
-- deploy lands.
-- ============================================================================

DROP TABLE IF EXISTS market_indices;
DROP TABLE IF EXISTS signals;
DROP TABLE IF EXISTS sectors;
DROP TABLE IF EXISTS news;
DROP TABLE IF EXISTS investment_ideas;
DROP TABLE IF EXISTS recommendations;
DROP TABLE IF EXISTS research_reports;
DROP TABLE IF EXISTS research_notes;

-- Used only by the tables above.
DROP TYPE IF EXISTS signal_action;
DROP TYPE IF EXISTS news_direction;
DROP TYPE IF EXISTS risk_level;
