import React from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

/**
 * Staff-area authorization guard. Only `admin` users may enter /portal/staff;
 * a signed-in client is bounced to their own portal. (Unauthenticated users are
 * already handled upstream by the proxy + portal layout.) This is the app-level
 * complement to the RLS `is_staff()` policies enforced in the database.
 */
export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/portal/client");
  return <>{children}</>;
}
