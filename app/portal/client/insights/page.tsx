import { getActiveClientId } from "@/lib/session";
import {
  getPositions,
  getSectors,
  getNews,
  getResearchReports,
} from "@/lib/data/queries";

function newsTime(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Australia/Sydney",
  });
}

// Server Component: sector momentum, news, and research from the DAL, with the
// client's holdings highlighted.
export default async function ClientInsightsPage() {
  const clientId = await getActiveClientId();
  const [positions, sectors, news, reports] = await Promise.all([
    getPositions(clientId),
    getSectors(),
    getNews(),
    getResearchReports(),
  ]);

  const holdings = positions.map((p) => p.code);
  const maxMom = Math.max(1, ...sectors.map((s) => Math.abs(s.momentum)));

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Market intelligence &middot; Friday 12 Jun</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Insights</h1>
        <p className="text-xs text-mut mt-1">
          Where the money is moving, what’s driving it, and how it reads across your book.
        </p>
      </div>

      {/* Sector Momentum */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut">Sector momentum</div>

        <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow space-y-4">
          {sectors.map((s, idx) => {
            const hasStock = s.beneficiaries.filter(code => holdings.includes(code));
            const momPercent = Math.max(5, Math.round((Math.abs(s.momentum) / maxMom) * 100));
            const isNegative = s.momentum < 0;

            return (
              <div key={s.name} className={`${idx > 0 ? "border-t border-line pt-3.5" : ""} space-y-1.5`}>
                <div className="flex justify-between items-center text-xs">
                  <b className="text-sm font-semibold text-ink leading-tight">{s.name}</b>
                  <div className="flex items-center gap-2 font-mono font-bold text-xs select-none">
                    {/* Momentum Bar */}
                    <div className="w-20 h-1.5 bg-paper-2 rounded-full overflow-hidden flex justify-end">
                      <div
                        style={{ width: `${momPercent}%` }}
                        className={`h-full rounded-full ${isNegative ? "bg-loss" : "bg-green"}`}
                      />
                    </div>
                    <span className={isNegative ? "text-loss-d" : "text-gain"}>
                      {s.momentum >= 0 ? "+" : ""}{s.momentum.toFixed(1)}%
                    </span>
                  </div>
                </div>

                <div className="text-[12.5px] text-mut leading-relaxed">{s.drivers}</div>

                <div className="text-[11px] flex gap-2 items-center flex-wrap">
                  {s.beneficiaries.length > 0 ? (
                    <span className="text-mut flex gap-2">
                      Names:{" "}
                      {s.beneficiaries.map(code => (
                        <span
                          key={code}
                          className={`code font-mono px-1 rounded-sm ${holdings.includes(code) ? "text-green-d font-bold" : ""}`}
                        >
                          {code} {holdings.includes(code) && "●"}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-mut">No direct names on platform</span>
                  )}

                  {hasStock.length > 0 ? (
                    <span className="pill bg-green-bg text-green-d text-[10px] font-bold px-2 py-0.5 rounded-full ml-auto">
                      You hold {hasStock.length}
                    </span>
                  ) : s.beneficiaries.length > 0 && s.momentum > 2 ? (
                    <span className="pill bg-amber-bg text-amber-d text-[10px] font-bold px-2 py-0.5 rounded-full ml-auto">
                      Not in your book
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Grid: News & Strategy */}
      <div className="grid md:grid-cols-2 gap-4">
        {/* News Wire */}
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="flex justify-between items-center px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Global news &amp; impact</b>
            <span className="text-mut text-xs font-semibold">live wire</span>
          </div>

          <div className="p-4.5 space-y-4">
            {news.map((nw, idx) => (
              <div key={nw.id} className={`${idx > 0 ? "border-t border-line pt-4" : ""} space-y-2`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${nw.direction === "up" ? "bg-green-bg text-green-d" : "bg-loss-bg text-loss-d"}`}>
                    {nw.impact}
                  </span>
                  <span className="font-mono text-[10px] text-mut uppercase tracking-wider">
                    {nw.source} &middot; {newsTime(nw.ts)}
                  </span>
                </div>
                <div className="font-semibold text-[13.5px] leading-snug">{nw.headline}</div>
                <p className="text-xs text-mut leading-relaxed">
                  <b className="text-green-d">How to use it:</b> {nw.use}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Strategy note */}
        <div className="space-y-4">
          <div className="card bg-navy text-[#dfe2ee] border-navy p-5 rounded-[14px] shadow-shadow space-y-3 relative overflow-hidden">
            <div className="absolute inset-0 bg-linear-to-r from-green to-transparent opacity-5" />
            <div className="text-xs font-semibold text-white/50 flex justify-between">
              <span>This week’s theme</span>
              <span className="font-mono uppercase tracking-wider">deep dive</span>
            </div>
            <h3 className="font-disp font-medium text-lg leading-tight text-white">The lithium deficit is back on the table</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Supply discipline and resurgent EV demand point to a structural deficit from 2027. We prefer the lowest-cost producers with balance-sheet resilience — PLS is our key exposure.
            </p>
          </div>

          {/* Research notes library */}
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
            <b className="text-sm font-semibold text-ink block">Research library</b>
            <div className="divide-y divide-line text-xs font-medium">
              {reports.map((rp) => (
                <div key={rp.id} className="py-2.5 space-y-0.5">
                  <div className="font-semibold text-ink">{rp.title}</div>
                  <div className="text-mut text-[10.5px]">
                    {rp.kind} &middot; {new Date(rp.published).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; {rp.pages} pp
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
