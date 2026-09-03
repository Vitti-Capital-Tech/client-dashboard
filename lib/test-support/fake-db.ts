/* eslint-disable @typescript-eslint/no-explicit-any --
 * This module emulates an untyped remote API. PostgREST hands back whatever the
 * selected columns happen to be, and the real client's builder is generic over
 * a schema this fake deliberately does not have — narrowing here would describe
 * the fake rather than the thing it stands in for. `any` is the honest type. */

// An in-memory stand-in for the Supabase/PostgREST client, for tests.
// ----------------------------------------------------------------------------
// The importers and the P&L recompute are mostly database choreography — which
// rows a full replace may delete, whether re-running a file double-counts it,
// whether a ticker that disappears from the sources disappears from the stored
// P&L. None of that is exercised by testing the pure functions underneath, and
// all of it is exactly what breaks money.
//
// So the tests run against this instead of a real project: fast, hermetic, and
// safe to run on a laptop that has production credentials in .env.local.
//
// It implements only what the callers actually use. When something new is
// needed, add it here rather than reaching for a live database.

import type { AdminDb } from "../import/runner.ts";

export type Row = Record<string, any>;

/**
 * PostgREST's default `max-rows`, enforced here so tests feel it too.
 *
 * The cap is silent — a short array, no error, no flag — and it truncated the
 * realised-P&L replay to the first thousand of nearly four thousand trades,
 * producing a complete-looking and entirely wrong answer. A fake that returned
 * everything would let that class of bug back in unnoticed.
 */
const MAX_ROWS = 1000;

/**
 * The fluent builder. Thenable rather than a Promise because the real one is
 * too — `db.from("securities").select("code")` is awaited with no filter at all.
 */
class FakeBuilder {
  // Plain fields assigned in the constructor body: Node's strip-only TypeScript
  // mode rejects parameter properties, and these files run with no build step.
  filters: ((r: Row) => boolean)[] = [];
  tables: Record<string, Row[]>;
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  payload: any;
  opts: any;
  /** Set by a trailing `.select()` on an insert, which returns the new rows. */
  returning = false;
  sortBy: { col: string; ascending: boolean } | null = null;
  take: number | null = null;
  rangeFrom: number | null = null;
  rangeTo: number | null = null;

  constructor(
    tables: Record<string, Row[]>,
    table: string,
    op: "select" | "insert" | "upsert" | "update" | "delete",
    payload: any = null,
    opts: any = {},
  ) {
    this.tables = tables;
    this.table = table;
    this.op = op;
    this.payload = payload;
    this.opts = opts;
  }

  in(col: string, vals: any[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }

  eq(col: string, val: any) {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  /**
   * `is(col, null)` — SQL's IS NULL, which `eq` cannot express.
   *
   * A column the seed row simply does not carry counts as null, the way a real
   * table's default does: the tracker queue asks for `tracker_written_at IS NULL`
   * and a fixture written before that column existed must read as owed, not as
   * invisible.
   */
  is(col: string, val: null | boolean) {
    this.filters.push((r) => (val === null ? (r[col] ?? null) === null : r[col] === val));
    return this;
  }

  /** Real ordering, because callers use it to pick "the latest" row. */
  order(col?: string, opts?: { ascending?: boolean }) {
    if (col) this.sortBy = { col, ascending: opts?.ascending !== false };
    return this;
  }

  limit(n: number) {
    this.take = n;
    return this;
  }

  /** Real paging, against the same cap the real client enforces. */
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  /** `insert(...).select("id")` — the builder keeps going and returns rows. */
  select(cols?: string) {
    if (this.op === "insert") {
      this.returning = true;
      return this;
    }
    this.op = "select";
    this.payload = cols;
    return this;
  }

  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }

  private rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  private matching(): Row[] {
    return this.rows().filter((r) => this.filters.every((f) => f(r)));
  }

  /**
   * Resolve a PostgREST embed (`positions.select("…, securities(code)")`) the
   * way the real join would, so callers that rely on one are actually covered.
   */
  private embed(r: Row, cols: string): Row {
    const out = { ...r };

    if (cols.includes("securities(")) {
      const sec = (this.tables.securities ?? []).find(
        (s) => s.code === r.security_code,
      );
      out.securities = sec
        ? { code: sec.code, parent_code: sec.parent_code ?? null }
        : null;
    }

    if (cols.includes("clients(")) {
      const client = (this.tables.clients ?? []).find((c) => c.id === r.client_id);
      out.clients = client
        ? {
            display_name: client.display_name,
            // Absent in the fixture means the column's default — an empty array,
            // not null — so a test that never mentions aliases behaves like a
            // client that has none rather than like a broken row.
            placement_aliases: client.placement_aliases ?? [],
          }
        : null;
    }

    if (cols.includes("accounts(")) {
      const account = (this.tables.accounts ?? []).find((a) => a.id === r.account_id);
      out.accounts = account ? { external_ref: account.external_ref ?? null } : null;
    }

    return out;
  }

  private nextId(): string {
    return `${this.table}-${this.rows().length + 1}`;
  }

  private run() {
    switch (this.op) {
      case "select": {
        const cols = String(this.payload ?? "");
        let rows = this.matching();

        if (this.sortBy) {
          const { col, ascending } = this.sortBy;
          rows = [...rows].sort((a, b) => {
            // Nulls last either way — a row with no value for the sort key is
            // never "the latest".
            if (a[col] == null) return 1;
            if (b[col] == null) return -1;
            const cmp = a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0;
            return ascending ? cmp : -cmp;
          });
        }

        if (this.take !== null) rows = rows.slice(0, this.take);

        // The cap applies whether or not a range was asked for — that is what
        // makes it a trap in the real client, so the fake reproduces it.
        if (this.rangeFrom !== null) {
          const asked = (this.rangeTo ?? this.rangeFrom + MAX_ROWS - 1) - this.rangeFrom + 1;
          rows = rows.slice(this.rangeFrom, this.rangeFrom + Math.min(asked, MAX_ROWS));
        } else {
          rows = rows.slice(0, MAX_ROWS);
        }

        return { data: rows.map((r) => this.embed(r, cols)), error: null };
      }

      case "insert": {
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
        const created = incoming.map((row) => {
          // Surrogate ids come from the database, so the fake has to mint them
          // too — callers read the new `pnl_runs.id` straight back out.
          const withId = { id: this.nextId(), ...row };
          this.rows().push(withId);
          return withId;
        });
        return { data: this.returning ? created : null, error: null };
      }

      case "upsert": {
        const keys = String(this.opts.onConflict ?? "id")
          .split(",")
          .map((k) => k.trim());
        // The real client takes a single row or an array; so does this.
        const payload: Row[] = Array.isArray(this.payload)
          ? this.payload
          : [this.payload];
        for (const incoming of payload) {
          const existing = this.rows().find((r) =>
            keys.every((k) => r[k] === incoming[k]),
          );
          if (existing) Object.assign(existing, incoming);
          else this.rows().push({ id: this.nextId(), ...incoming });
        }
        return { error: null };
      }

      case "update": {
        for (const r of this.matching()) Object.assign(r, this.payload);
        return { error: null };
      }

      case "delete": {
        const doomed = new Set(this.matching());
        this.tables[this.table] = this.rows().filter((r) => !doomed.has(r));
        return { error: null, count: doomed.size };
      }
    }
  }
}

export function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    clients: [],
    accounts: [],
    securities: [],
    positions: [],
    trades: [],
    realized_pnl: [],
    pnl_runs: [],
    pnl_summary: [],
    pnl_recompute_queue: [],
    ...seed,
  };

  /**
   * How many SELECTs each table has served.
   *
   * Counting queries rather than checking results, because the thing worth
   * pinning here is not WHAT came back but HOW OFTEN it was asked for: a
   * catalogue read once per batch and one read twice per account return exactly
   * the same rows, and the difference between them is a morning that finishes
   * and one that does not.
   *
   * Only top-level reads count. `.insert(…).select("id")` chains off the
   * builder, not off `from`, so a write's returning clause is not a read.
   */
  const reads: Record<string, number> = {};

  const db = {
    from: (table: string) => ({
      select: (cols?: string) => {
        reads[table] = (reads[table] ?? 0) + 1;
        return new FakeBuilder(tables, table, "select", cols);
      },
      insert: (rows: Row | Row[]) => new FakeBuilder(tables, table, "insert", rows),
      upsert: (rows: Row[], opts: any) =>
        new FakeBuilder(tables, table, "upsert", rows, opts),
      update: (patch: Row) => new FakeBuilder(tables, table, "update", patch),
      delete: (opts?: any) => new FakeBuilder(tables, table, "delete", null, opts),
    }),
  };

  return { db: db as unknown as AdminDb, tables, reads };
}
