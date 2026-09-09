import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { CustomiseClient } from "@/app/components/CustomiseClient";

export const metadata = {
  title: "Customise Appearance — Vitti Capital Desk",
  description: "Personalise your staff dashboard color palette, dark mode, opacities, and typography.",
};

export default async function StaffCustomisePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  if (session.role !== "admin") redirect("/portal/client");

  return (
    <CustomiseClient
      clientName="Staff Desk"
    />
  );
}
