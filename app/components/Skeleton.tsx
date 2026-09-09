/**
 * One grey block, pulsing.
 *
 * Deliberately the only piece: a skeleton is a drawing of a page, and the way
 * to keep those honest is to build each one out of blocks the size of the
 * things it is standing in for, rather than to invent a component per screen.
 *
 * `bg-line` rather than a fixed grey, so it follows the theme — Midnight Slate
 * is the default now, and a light-grey skeleton on a dark page reads as content
 * that has already loaded and is wrong.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`rounded-md bg-line animate-pulse motion-reduce:animate-none ${className}`}
    />
  );
}
