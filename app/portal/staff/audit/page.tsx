import { getAuditLog } from "@/lib/data/queries";
import { ExportButton } from "./ExportButton";

// Server Component: audit trail from the DAL (append-only audit_log table).
export default async function StaffAuditLog() {
  const audit = await getAuditLog(200);

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Security &middot; immutable register</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5">Audit log</h1>
          <p className="text-xs text-mut mt-1">
            Every sign-in, placement bid, allocation publish, and security adjustment is recorded with user metadata.
          </p>
        </div>
        <ExportButton />
      </div>

      {/* Audit Logs Table */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">Timestamp</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">User</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">Action</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] hidden md:table-cell">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {audit.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center text-mut py-6">No audit records on file.</td>
                </tr>
              ) : (
                audit.map((e) => (
                  <tr key={e.id} className="hover:bg-[#faf9f5]">
                    <td className="px-4.5 py-3 font-mono text-mut whitespace-nowrap text-[11.5px]">
                      {new Date(e.ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot;{" "}
                      {new Date(e.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </td>
                    <td className="px-4.5 py-3">
                      <div className="font-semibold text-ink leading-tight">{e.actor}</div>
                      <div className="text-[10px] text-mut uppercase font-semibold mt-0.5">{e.role}</div>
                    </td>
                    <td className="px-4.5 py-3 font-semibold text-ink">{e.action}</td>
                    <td className="px-4.5 py-3 text-mut leading-relaxed hidden md:table-cell truncate max-w-75">
                      {e.detail}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
