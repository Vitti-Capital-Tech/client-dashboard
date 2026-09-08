import { redirect } from "next/navigation";
import { getSession, getActiveClientId } from "@/lib/session";
import { getClient } from "@/lib/data/queries";
import { CustomiseClient } from "./CustomiseClient";

export const metadata = {
  title: "Customise Appearance — Vitti Capital",
  description: "Personalise your client dashboard color palette, opacities, and typography.",
};

export default async function ClientCustomisePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  if (session.role === "admin") redirect("/portal/staff");

  const clientId = await getActiveClientId();
  const client = await getClient(clientId);

  return (
    <CustomiseClient
      clientName={client?.name ?? "Client"}
    />
  );
}
