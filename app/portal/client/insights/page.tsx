import { Lightbulb } from "lucide-react";

export const metadata = {
  title: "Insights — Vitti Capital",
};

/**
 * Insights — a placeholder, and deliberately an empty one.
 *
 * The route is real because the nav entry is real: this is the page the desk is
 * about to build, and a tab that goes nowhere is the thing the coming-soon list
 * exists to prevent. What it will hold has not been decided, so nothing is
 * drawn here in the meantime.
 *
 * There is no mock content on purpose. Every screen in this app that once had
 * placeholder figures — a fabricated day move, a hardcoded "+1.2% today",
 * invented market colour under an "auto-generated" heading — had to be found
 * and torn out later, because the moment a client can sign in, illustrative
 * numbers read as their numbers. An empty page is honest and costs one commit
 * to fill.
 *
 * Note the split from Market: /portal/client/market is the ASX filings, sector
 * momentum and research library. This is separate, and whatever goes here
 * should be a reason to open it rather than a second copy of that.
 */
export default function ClientInsightsPage() {
  return (
    <div className="space-y-4 text-ink font-body">
      <div className="select-none">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">
          Your book
        </div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Insights</h1>
      </div>

      <div className="card bg-white border border-line rounded-[14px] shadow-shadow px-6 py-12 text-center">
        <Lightbulb
          className="w-6 h-6 stroke-[1.5] text-mut mx-auto mb-3"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold text-ink">Being built</p>
        <p className="text-xs text-mut mt-1.5 max-w-80 mx-auto leading-relaxed">
          This is where reading of your own holdings will live. Market news,
          sector momentum and the research library are under Market in the
          meantime.
        </p>
      </div>
    </div>
  );
}
