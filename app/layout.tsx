import type { Metadata } from "next";
import { hankenGrotesk, fraunces, ibmPlexMono } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vitti Capital — Portfolio & Placements Platform",
  description: "One platform for portfolios, placements, and critical options exercise windows.",
  /**
   * The tab icon is the V mark from the brand logo (public/logo.jpeg), cropped
   * out of it and squared on the same navy.
   *
   * The wordmark under the mark is not in here on purpose: "vitti.capital
   * Empowering Growth, Together" is four words and a tagline, and at the 16px a
   * browser tab actually draws it is a grey smudge. The mark alone survives the
   * size, which is the only job this image has.
   *
   * The SVG that used to head this list is gone rather than left in place. It
   * drew a different logo — a candle-chart badge from before this one — and
   * being first in the list, it was the one every modern browser picked, so the
   * PNG below was decoration. There is no vector of the new mark to replace it
   * with; the .ico carries 16 through 256 so nothing is upscaled.
   */
  icons: {
    icon: [
      { url: "/icon.png", type: "image/png" },
      { url: "/favicon.ico" },
    ],
    apple: [{ url: "/icon.png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${hankenGrotesk.variable} ${fraunces.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-body bg-paper text-ink">
        
          {children}
        
      </body>
    </html>
  );
}
