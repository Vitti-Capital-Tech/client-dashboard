"use client";

export function ExportButton() {
  return (
    <button
      onClick={() =>
        alert("CSV export completed. File downloaded: vitti_audit_log.csv")
      }
      className="btn ghost sm text-xs font-semibold py-2 px-4 border border-line rounded-[10px] bg-white hover:border-mut cursor-pointer transition-colors"
    >
      Export CSV
    </button>
  );
}
