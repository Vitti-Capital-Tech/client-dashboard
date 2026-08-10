-- ============================================================================
-- clients.placement_aliases — the names the Placement Tracker calls this client
-- ----------------------------------------------------------------------------
-- The tracker's CLIENT NAME column is hand-typed and `clients.display_name` is
-- not, so one party is written several ways. Canonicalising spelling gets some of
-- the way (`Pty Ltd` ≡ `P/L`, `Inv` ≡ `Investments` — see `isClientMatch`), and
-- then it stops, because the remaining differences are not spelling:
--
--     database                          tracker
--     ------------------------------    ------------------------------------
--     Psg Capital Investments PTY LTD   PSG Capital Pty Ltd · PSG Capital Ltd ·
--                                       PSG Capital · PSG Investments
--     Psg Superfund PTY LTD             PSG Super · PSG Super Fund ·
--                                       PSG Superfund Pty Ltd
--     R Chawla & G Vijan PTY LTD        R Chawla & G Vijan · R Chawla
--     Rg Vijan PTY LTD                  RG Vijan Super Fund · RG Vijan Super
--
-- `PSG Capital Ltd` and `PSG Super` are one word apart and belong to two
-- different clients. No string-distance rule can settle that — it is a fact about
-- the desk's records — and a matcher loose enough to try would move a placement
-- parcel between two real clients, silently, into stored P&L.
--
-- So the mapping is stated rather than inferred. Anything listed here is treated
-- exactly like the client's own name when reading a placement sheet.
--
-- Matching still normalises, so only genuinely DIFFERENT names need listing:
-- case, punctuation, `Pty Ltd` vs `P/L`, and a trailing `ATF …` are already
-- handled.
-- ============================================================================

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS placement_aliases text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN clients.placement_aliases IS
  'Names the Placement Tracker uses for this client, in addition to display_name. '
  'Read by the P&L placement merge; each entry is matched exactly as display_name is. '
  'Add a name here only when it is certain: an alias moves a placement parcel onto '
  'this client''s P&L.';

-- No new RLS. The column lives on `clients`, whose existing policies already say
-- staff read and write every row and a client reads only their own — which is
-- exactly the intent here, and a second policy would be a second thing to keep in
-- step with the first.

-- ----------------------------------------------------------------------------
-- Populating it (run in the SQL editor, one statement per client)
-- ----------------------------------------------------------------------------
-- Deliberately NOT seeded by this migration: which tracker name belongs to which
-- entity is the desk's call, and a wrong guess committed to git is worse than an
-- empty column that reports its gaps out loud.
--
--   UPDATE clients
--      SET placement_aliases = ARRAY['PSG Capital Pty Ltd', 'PSG Capital Ltd', 'PSG Investments']
--    WHERE display_name = 'Psg Capital Investments PTY LTD';
--
-- To find the candidates, look at what the unfilled rows actually list — the
-- client profile names the tickers, and the tracker sheet names its participants.
--
-- Aliases are read LIVE from this table, so changing one needs a Recalculate on
-- that client and nothing else — no "Refresh trackers", since the workbooks have
-- not changed. (The release that added this column also changed the tracker
-- PARSER, which does need one refresh to take effect. That is a one-off and has
-- nothing to do with aliases.)
