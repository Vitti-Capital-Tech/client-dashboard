/**
 * The words the portal uses, defined once.
 *
 * ── Why this is a module and not a page ─────────────────────────────────────
 * The definitions were already in the product, scattered as `title=` strings on
 * individual `<th>` elements — "Qty × (Spot − Strike), floored at zero" lived
 * inside `OptionsClient.tsx` and nowhere else. That is fine until the same
 * column appears on a second screen, at which point there are two definitions
 * of one term and nothing keeps them in step. For a financial product a wrong
 * definition is a compliance problem, so there has to be exactly one place to
 * correct it.
 *
 * There is deliberately no /glossary route. A reference page is a place clients
 * do not go: the moment of confusion is in front of a table on the page they
 * are already on, and a word they have to navigate away to look up is a word
 * they ask the desk about instead. So each page carries its own terms — the
 * ones actually visible on it — in a strip at the top (`GlossaryStrip`).
 *
 * ── The rule these are written to ───────────────────────────────────────────
 * A definition says what a number IS and how it is arrived at. It never says
 * what to do about it. "Open P&L is the gain or loss on holdings you still own"
 * is a definition; "a large open loss may be worth reviewing" is advice, and
 * this file is read by retail-facing screens in a wholesale product where that
 * distinction is the whole regulatory point. The same rule the commentary
 * validator enforces on generated text (`lib/commentary/prompt.ts`), applied by
 * hand to text a human wrote.
 *
 * `short` is one sentence, for the collapsed strip and for any tooltip that
 * wants it later. `long` may add a second and a third, and is what the expanded
 * strip renders. Neither carries a figure — a definition that quotes a number
 * goes stale, and the client's own number is on the screen beside it.
 */

export type GlossaryEntry = {
  /** Stable key, used by `PAGE_TERMS` below and as the React list key. */
  slug: string;
  term: string;
  /** Other spellings the same idea appears under, shown beside the term. */
  also?: string[];
  /** One sentence. What the tooltip shows. */
  short: string;
  /** The reference entry. Falls back to `short` when there is no more to say. */
  long?: string;
};

export const GLOSSARY: GlossaryEntry[] = [
  /* ───────────────────────────── portfolio ──────────────────────────────── */
  {
    slug: "total-portfolio",
    term: "Total portfolio",
    short: "Everything you hold, at the last price we have, plus cash.",
    long:
      "Everything you hold, valued at the last price we have for it, plus cash. Unlisted holdings and option grants are included at the desk's valuation rather than at a market price, because they do not trade on a market.",
  },
  {
    slug: "cost-base",
    term: "Cost base",
    also: ["Cost"],
    short: "What you paid for what you hold, across all your accounts.",
    long:
      "What you paid, across all your accounts — the total of every purchase, taken from your contract notes. It is the figure profit and loss is measured against. Where a parcel came from a placement rather than an on-market buy, the cost is taken from the placement's own records.",
  },
  {
    slug: "open-pnl",
    term: "Open P&L",
    also: ["Unrealised P&L", "Unreal. P&L"],
    short:
      "The gain or loss on holdings you still own — the difference between what you paid and what they are worth now.",
    long:
      "The gain or loss on holdings you still own: what they are worth at the last price, less what you paid. It moves with the market every day and is not money that has changed hands — it becomes realised only if and when a holding is sold. Shown elsewhere in the industry as 'unrealised P&L'.",
  },
  {
    slug: "realised-pnl",
    term: "Realised P&L",
    short: "The gain or loss on holdings that have been sold — money that has changed hands.",
    long:
      "The gain or loss on holdings that have already been sold: sale proceeds less the cost of the parcel sold. Unlike open P&L it does not move once it is booked, because the transaction is finished. Where a parcel was bought in several lots, the cost is matched on a weighted average.",
  },
  {
    slug: "market-value",
    term: "Market value",
    also: ["Current value", "Value"],
    short: "What a holding is worth at the last price we have for it.",
    long:
      "What a holding is worth at the last price we have for it — quantity times price. For a listed security that is the last traded price on the ASX; for an unlisted holding or an option grant it is the desk's valuation, which is struck less often.",
  },
  {
    slug: "holding",
    term: "Holding",
    also: ["Position", "Parcel"],
    short: "A quantity of one security that you own.",
    long:
      "A quantity of one security that you own. A holding is 'open' while you still own some of it and 'closed' once all of it has been sold; a parcel is one lot within a holding, usually one purchase.",
  },
  {
    slug: "listed",
    term: "Listed",
    short: "Quoted on the ASX, so it has a public price and can be bought and sold on market.",
    long:
      "Quoted on the ASX, so it has a public price and can be bought and sold on market at any time the exchange is open. The opposite is unlisted.",
  },
  {
    slug: "unlisted",
    term: "Unlisted",
    short: "Not quoted on any exchange — it has no public price and cannot be sold on market.",
    long:
      "Not quoted on any exchange. An unlisted holding or option grant has no public price, so it is carried at the desk's valuation rather than at a market price, and it cannot be sold on market. Companies that later list convert these to listed holdings.",
  },
  {
    slug: "sector",
    term: "Sector",
    short: "The industry a company is classified under — Materials, Energy, Health Care and so on.",
    long:
      "The industry a company is classified under, using the standard GICS categories the ASX itself reports against: Materials, Energy, Health Care, Financials and the rest. The sector split shows how much of your portfolio sits in each.",
  },

  /* ────────────────────────────── options ───────────────────────────────── */
  {
    slug: "option",
    term: "Option",
    short: "A right to buy shares at a fixed price, up to a fixed date. A right, not an obligation.",
    long:
      "A right to buy shares in a company at a fixed price (the strike), up to a fixed date (the expiry). It is a right rather than an obligation — if the shares are worth less than the strike when it expires, the option simply lapses and nothing is owed.",
  },
  {
    slug: "strike",
    term: "Strike",
    also: ["Exercise price"],
    short: "The fixed price at which an option lets you buy the shares.",
    long:
      "The fixed price at which an option lets you buy the shares, set when the option is issued and unchanged for its life. Also called the exercise price. Whether the option is worth exercising is a comparison between the strike and the spot.",
  },
  {
    slug: "spot",
    term: "Spot",
    also: ["Underlying price"],
    short: "The current market price of the shares the option is over.",
    long:
      "The current market price of the shares the option is over — the 'underlying'. It moves all day while the market is open, which is why an option's value moves with it.",
  },
  {
    slug: "exercise-value",
    term: "Exercise value",
    short:
      "What exercising the option would be worth right now: quantity × (spot − strike), never less than zero.",
    long:
      "What exercising the option would be worth at today's price: quantity × (spot − strike), floored at zero because an option that is out of the money is not worth exercising rather than being worth a negative amount. It ignores the time left to run, which is why it is not the same as the option's full value.",
  },
  {
    slug: "moneyness",
    term: "Moneyness",
    also: ["ITM", "ATM", "OTM", "In the money", "Out of the money"],
    short:
      "Where the share price sits against the strike: in the money (above), at the money (level) or out of the money (below).",
    long:
      "Where the share price sits against the strike. In the money (ITM) means the shares are worth more than the strike, so exercising has value today. Out of the money (OTM) means they are worth less. At the money (ATM) means the two are roughly level. An out-of-the-money option is not worthless while it still has time to run — the price can move.",
  },
  {
    slug: "expiry",
    term: "Expiry",
    also: ["DTE", "Days to expiry"],
    short: "The last date an option can be exercised. After it, the option lapses.",
    long:
      "The last date an option can be exercised; after it the option lapses and cannot be used. DTE is the number of days remaining. An in-the-money option approaching expiry is the one case where the date matters more than the price.",
  },
  {
    slug: "series",
    term: "Series",
    short: "One specific option: a company, a strike and an expiry together.",
    long:
      "One specific option, identified by the company, the strike and the expiry together. Two grants over the same company with different strikes are two series, and they are listed and valued separately.",
  },
  {
    slug: "exercise",
    term: "Exercise",
    short: "Using an option to buy the shares at the strike price.",
    long:
      "Using an option to buy the shares at the strike price, which requires paying the strike for each share. Exercising turns an option into a holding of shares; it is a decision for you and your adviser, and the portal reports the position rather than acting on it.",
  },

  /* ──────────────────────────── placements ──────────────────────────────── */
  {
    slug: "placement",
    term: "Placement",
    also: ["Capital raising", "Deal"],
    short:
      "A company issuing new shares directly to selected investors, usually at a discount to the market price.",
    long:
      "A company issuing new shares directly to selected investors to raise capital, usually priced at a discount to the market price. Placements are offered to wholesale investors only and are not available on market, which is why they arrive through the desk rather than through a broker screen.",
  },
  {
    slug: "bid",
    term: "Bid",
    short: "The amount you apply for in a placement. It is an application, not a purchase.",
    long:
      "The amount you apply for in a placement. It is an application rather than a purchase: what you actually receive is decided at allocation, and can be less than you bid or nothing at all. A bid can be amended or withdrawn until the book closes.",
  },
  {
    slug: "book-close",
    term: "Book close",
    also: ["Bids close"],
    short: "The deadline for bidding in a placement. After it, bids can no longer be changed.",
    long:
      "The deadline for bidding in a placement. Until it passes a bid can be amended or withdrawn; after it the book is with the company and its broker, and allocation follows.",
  },
  {
    slug: "allocation",
    term: "Allocation",
    also: ["Scaled", "Scaleback"],
    short:
      "What you were actually granted in a placement, which can be less than you bid if the deal was oversubscribed.",
    long:
      "What you were actually granted in a placement. When a deal is oversubscribed — more was bid than there are shares to issue — bids are scaled back, and everyone receives a proportion of what they asked for. A nil allocation means the bid was unsuccessful; nothing is owed in that case.",
  },
  {
    slug: "discount",
    term: "Discount",
    short: "How far a placement's issue price sits below the market price at the time.",
    long:
      "How far a placement's issue price sits below the share's market price when the deal was struck, as a percentage. It is the compensation for taking stock that cannot be sold instantly and in size, and it is not a guaranteed gain — the market price can move before the shares are yours.",
  },
  {
    slug: "s708",
    term: "s708 / wholesale investor",
    also: ["Sophisticated investor", "Section 708"],
    short:
      "The Corporations Act test that lets you be offered deals without a prospectus — certified by your accountant.",
    long:
      "Section 708 of the Corporations Act sets out who may be offered securities without a prospectus or product disclosure statement: broadly, investors above certain asset or income thresholds, certified by a qualified accountant. Your certificate is what makes placements available to you, and it has an expiry — the desk will ask you to renew it.",
  },
  {
    slug: "bpay",
    term: "BPAY",
    short: "The payment method for settling an allocation, using the reference on your deal page.",
    long:
      "The payment method used to settle a placement allocation. The biller code and reference are specific to your allocation and are shown on the deal page; paying with the wrong reference is what delays settlement most often.",
  },

  /* ────────────────────────── market and settlement ─────────────────────── */
  {
    slug: "asx-session",
    term: "ASX session",
    also: ["Pre-open", "Market open", "Closing auction"],
    short:
      "The trading day: pre-open from 7am, trading 10am to 4pm, then a closing auction, Sydney time.",
    long:
      "The ASX trading day, in Sydney time. Orders can be queued from 7am (pre-open) but nothing trades until the market opens at 10am. Normal trading runs to 4pm, and a closing auction between about 4:10pm and 4:11pm sets the day's closing price. The market does not trade on weekends or exchange holidays, and closes early at 2:10pm on the last trading day before Christmas and the last of the year.",
  },
  {
    slug: "last-price",
    term: "Last price",
    short: "The price of the most recent trade in a security — not necessarily the price right now.",
    long:
      "The price at which the security most recently traded. Outside market hours it is the closing price; for a security that trades rarely it can be hours or days old, which is why a valuation built on it is an estimate rather than a quote.",
  },
  {
    slug: "contract-note",
    term: "Contract note",
    short: "The broker's record of a single trade — the source of every cost and sale figure here.",
    long:
      "The broker's record of a single completed trade: the security, the quantity, the price, the brokerage and the date. Every cost base and realised P&L figure in this portal is built from contract notes rather than typed in, which is why a missing note shows up as a gap rather than being quietly estimated.",
  },
  {
    slug: "settlement",
    term: "Settlement",
    also: ["T+2"],
    short: "When money and shares actually change hands — two business days after an ASX trade.",
    long:
      "When money and shares actually change hands, which is two business days after the trade on the ASX (T+2). A placement settles on its own timetable instead, set by the company and shown on the deal page.",
  },
  {
    slug: "trading-halt",
    term: "Trading halt",
    short: "A pause in trading a security, usually while the company prepares an announcement.",
    long:
      "A pause in trading a security, requested by the company and granted by the ASX, usually while it prepares an announcement the market has not seen. Capital raisings are commonly announced out of a halt. A halted security cannot be bought or sold until it resumes.",
  },
];

const BY_SLUG = new Map(GLOSSARY.map((e) => [e.slug, e]));

/** One entry, by slug. `undefined` when nothing is defined under that key. */
export function glossaryEntry(slug: string): GlossaryEntry | undefined {
  return BY_SLUG.get(slug);
}

/** The reference text: `long` where there is one, otherwise `short`. */
export function glossaryDefinition(entry: GlossaryEntry): string {
  return entry.long ?? entry.short;
}

/**
 * Which terms each page explains, and in what order.
 *
 * ── Why the list is here rather than at each call site ──────────────────────
 * `lib/nav/coming-soon.ts`'s reasoning, applied to words: one list, because the
 * alternative is eight arrays in eight components and no way to see that the
 * Options tab explains `strike` while the Portfolio tab, which shows the same
 * column, does not. Reading down this map is how that gap becomes visible.
 *
 * Every page's list is the terms that actually appear ON that page. A glossary
 * padded with words the reader cannot see is a glossary they stop reading.
 *
 * Keyed by route. A page with no entry renders no panel, so adding the
 * component to a page costs nothing until its terms are listed here.
 */
const PAGE_TERMS: Record<string, readonly string[]> = {
  "/portal/client": [
    "total-portfolio",
    "cost-base",
    "open-pnl",
    "realised-pnl",
    "holding",
    "sector",
    "asx-session",
  ],
  "/portal/client/positions": [
    "cost-base",
    "market-value",
    "open-pnl",
    "realised-pnl",
    "holding",
    "listed",
    "unlisted",
    "strike",
    "spot",
    "moneyness",
  ],
  "/portal/client/options": [
    "option",
    "series",
    "strike",
    "spot",
    "moneyness",
    "exercise-value",
    "exercise",
    "expiry",
    "unlisted",
    "open-pnl",
  ],
  "/portal/client/placements": [
    "placement",
    "bid",
    "book-close",
    "allocation",
    "discount",
    "s708",
    "bpay",
    "settlement",
    "trading-halt",
  ],
  "/portal/client/market": ["asx-session", "last-price", "trading-halt", "placement"],
  "/portal/client/insights": ["sector", "last-price", "trading-halt", "holding"],
  "/portal/client/watchlist": ["listed", "last-price", "sector"],
  "/portal/client/alerts": ["expiry", "moneyness", "open-pnl", "book-close"],
};

/**
 * The entries a route explains, already resolved.
 *
 * Longest-prefix rather than exact match, so a detail route under a section
 * (`/portal/client/placements/<id>`) inherits its section's terms instead of
 * silently rendering nothing — which is the failure mode that would never be
 * noticed, because an empty panel looks exactly like a page with no jargon.
 */
export function glossaryForPage(path: string): GlossaryEntry[] {
  const match = Object.keys(PAGE_TERMS)
    .filter((route) => path === route || path.startsWith(`${route}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!match) return [];
  return (PAGE_TERMS[match] ?? [])
    .map((slug) => BY_SLUG.get(slug))
    .filter((e): e is GlossaryEntry => e !== undefined);
}
