"use server";

import { getSession } from "@/lib/session";
import { buildPnlSummaryWorkbook } from "@/lib/export/xlsx";
import type { PnlSummaryRow } from "@/lib/export/order-history";

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
