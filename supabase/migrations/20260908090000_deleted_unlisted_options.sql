-- ============================================================================
-- deleted_unlisted_options — grants the desk has struck off the register
-- ----------------------------------------------------------------------------
-- The Options register is DERIVED. An unlisted line is not a row somebody
-- typed: `buildUnlistedOptionRows` reads the Placement Tracker's attaching-
-- options text, works out the entitlement from the shares held, prices it, and
-- writes a synthetic `<PARENT>-UO` row into `pnl_summary`. Every recompute
-- rebuilds those rows from scratch — that is what makes a re-upload or a price
-- refresh safe.
--
-- Which is also why deleting one cannot just be a DELETE. The row would go, the
-- desk would see it go, and the next morning's ingest would put it straight
-- back with no record that anyone had ever objected to it. A delete button that
-- undoes itself overnight is worse than no button: the register would look
-- corrected for a day and then quietly stop being.
--
-- So a deletion is RECORDED here and the engine consults this table. The
-- `pnl_summary` row is removed in the same breath so the screen updates now,
-- and this table is what keeps it removed.
--
-- ── Why (account, ticker) and not an id ─────────────────────────────────────
-- Because that is the grain `pnl_summary` itself is keyed at, and it is the
-- only key a SYNTHETIC row has — there is no persistent identity behind a
-- modelled grant to point at. One consequence is worth knowing: tranches on
-- one underlying are numbered in the order the tracker lists them (`GRV-UO`,
-- `GRV-UO2`), so if a tranche is later removed from the WORKBOOK the ones after
-- it shift up a number and this exclusion would then be holding down its
-- neighbour. Rare, and visible — the register shows what is missing and the
-- audit_log says what was deleted and when — but it is the reason a deletion
-- carries `company` below: the description is how an operator recognises that
-- the ticker no longer means what it meant when they deleted it.
--
-- ── Not a soft delete of the option itself ──────────────────────────────────
-- Nothing about the client's actual entitlement changes. This says "do not
-- report this grant", which is the right shape for what it is used for: a
-- tranche the tracker describes but the client never took up, a duplicate the
-- sheet states twice, a grant that lapsed unexercised. If the entitlement is
-- genuinely wrong, the tracker is where that gets fixed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS deleted_unlisted_options (
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,

  -- The synthetic register ticker, e.g. 'GRV-UO' / 'GRV-UO2'.
  ticker      text NOT NULL,

  -- The row's description as it read WHEN IT WAS DELETED — ratio, strike and
  -- expiry included. Denormalised on purpose: the grant it names is about to
  -- stop existing anywhere, so there is nothing left to join to.
  company     text,

  -- The desk's own words. Optional, because the common cases are obvious from
  -- the description and forcing prose produces "n/a".
  reason      text,

  deleted_by  text NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (account_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_deleted_unlisted_options_client
  ON deleted_unlisted_options(client_id);

COMMENT ON TABLE deleted_unlisted_options IS
  'Unlisted option grants the desk has removed from the register. Consulted by '
  'lib/pnl/recompute.ts, which drops the matching synthetic -UO row on every run '
  'so the deletion survives the next ingest. Delete a row here to restore a grant.';

-- ----------------------------------------------------------------------------
-- RLS — staff only, both ways.
-- ----------------------------------------------------------------------------
-- Unlike `pnl_summary` a client has no reason to read this: what they see is
-- the register with the grant already absent, and handing them a list of the
-- lines the desk decided not to report invites exactly the question the
-- deletion was meant to settle. The recompute runs as service_role and bypasses
-- RLS entirely.
ALTER TABLE deleted_unlisted_options ENABLE ROW LEVEL SECURITY;

CREATE POLICY deleted_unlisted_options_select ON deleted_unlisted_options
  FOR SELECT TO authenticated USING (is_staff());
CREATE POLICY deleted_unlisted_options_write ON deleted_unlisted_options
  FOR ALL TO authenticated USING (is_staff()) WITH CHECK (is_staff());
