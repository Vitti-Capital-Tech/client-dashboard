import Image from "next/image";

/**
 * The Vitti Capital lockup: the mark, then the name.
 *
 * ── One component, because there were two ───────────────────────────────────
 * The sidebar and the sign-in pages each carried their own copy of this markup,
 * and they had already drifted. Anything about the brand — which mark, how
 * "Capital" sits against "Vitti" — now has one place to be wrong in.
 *
 * ── Why the mark is an image with its own background ────────────────────────
 * It used to be three green bars drawn in CSS, which was not the logo. The real
 * mark is white and green ON navy, and it cannot be lifted off that navy: as a
 * transparent PNG it is a white triangle, invisible on the white sign-in page.
 * So the tile carries its own background and rounded corners, which reads on
 * the navy sidebar and on white alike, and is the same crop as the favicon —
 * the tab and the header are one image at two sizes.
 *
 * ── Why "Capital" is in a nested flex row ───────────────────────────────────
 * It used to sit visibly high. The row is `items-center`, and centring a
 * 10.5px box against the full line box of 20px display type does not put the
 * two on the same line — cap-height sits below the middle of its box, so the
 * small text floated above the name's baseline. The name and "Capital" are
 * their own `items-baseline` row now, so they share a baseline the way they do
 * in the logo; the mark stays centred against the pair.
 */
export function Wordmark({
  className = "",
  /** Rendered size of the mark in px. Roughly 1.3× the type size it sits beside. */
  markSize = 26,
}: {
  className?: string;
  markSize?: number;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2.5 font-disp font-semibold tracking-wide ${className}`}
    >
      <Image
        src="/mark.png"
        // Decorative: the name is right there in text, so a screen reader
        // announcing "Vitti Capital logo" would read the brand out twice.
        alt=""
        width={markSize}
        height={markSize}
        className="flex-none"
        priority
      />
      <span className="inline-flex items-baseline gap-1.5">
        Vitti
        <small className="font-body text-[0.55em] font-semibold tracking-[0.16em] uppercase opacity-60">
          Capital
        </small>
      </span>
    </span>
  );
}
