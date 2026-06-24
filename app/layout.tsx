import type { Metadata } from "next";
import { hankenGrotesk, fraunces, ibmPlexMono } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vitti Capital — Portfolio & Placements Platform",
  description: "One platform for portfolios, placements, and critical options exercise windows.",
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
