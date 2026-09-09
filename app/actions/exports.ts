"use server";

import { getSession } from "@/lib/session";
import { buildPnlSummaryWorkbook } from "@/lib/export/xlsx";
import type { PnlSummaryRow } from "@/lib/export/order-history";
import type { TradeLedgerRow } from "@/lib/export/xlsx";

/**
 * Spreadsheet generation, kept on the server on purpose.
 *
 * ExcelJS is ~1 MB; importing it from the client island would ship all of it to
 * every visitor for a button most never press. Behind a server action it stays
 * in the Node bundle and the browser receives only the finished bytes.
 *
 * The caller passes the rows it is already displaying rather than an id to
 * refetch, so the file is guaranteed to match the screen — the account filter,
 * the ordering and the flags cannot drift between the two. There is no
 * privilege concern in that: the action only formats data the caller supplied,
 * it reads nothing, and it is gated on an authenticated session.
 */
export async function buildPnlSummaryXlsx(
  rows: PnlSummaryRow[],
  title: string,
): Promise<string> {
  const session = await getSession();
  if (!session) throw new Error("Not authenticated");

  const buffer = await buildPnlSummaryWorkbook(rows, title);
  // Base64 because a server action returns JSON — it cannot stream a file body.
  return buffer.toString("base64");
}

/**
 * The trade ledger as a spreadsheet — the file a client hands an accountant.
 *
 * Same bargain as the P&L export above: ExcelJS stays on the server, and the
 * caller passes the rows it is displaying so the file matches the screen
 * including its filters. It reads nothing and only formats what it was given.
 */
export async function buildTradeLedgerXlsx(
  rows: TradeLedgerRow[],
  title: string,
): Promise<string> {
  const session = await getSession();
  if (!session) throw new Error("Not authenticated");

  const { buildTradeLedgerWorkbook } = await import("@/lib/export/xlsx");
  const buffer = await buildTradeLedgerWorkbook(rows, title);
  return buffer.toString("base64");
}
