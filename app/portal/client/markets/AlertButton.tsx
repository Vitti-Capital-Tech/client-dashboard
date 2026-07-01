"use client";

import type { ReactNode } from "react";

/**
 * Small client island for the markets page (a Server Component). The page
 * fetches + renders on the server; these placeholder buttons need an onClick,
 * so they live in their own "use client" boundary.
 */
export function AlertButton({
  message,
  className,
  children,
}: {
  message: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button onClick={() => alert(message)} className={className}>
      {children}
    </button>
  );
}
