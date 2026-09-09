import type { Metadata } from "next";
import {
  hankenGrotesk,
  fraunces,
  ibmPlexMono,
  inter,
  outfit,
  plusJakartaSans,
} from "@/lib/fonts";
import { ThemeProvider, ThemeInitScript } from "@/app/components/ThemeProvider";
import { ToastProvider } from "@/app/components/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vitti Capital — Portfolio & Placements Platform",
  description: "One platform for portfolios, placements, and critical options exercise windows.",
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
      suppressHydrationWarning
      className={`${hankenGrotesk.variable} ${fraunces.variable} ${ibmPlexMono.variable} ${inter.variable} ${outfit.variable} ${plusJakartaSans.variable} h-full antialiased`}
    >
      <head>
        <ThemeInitScript />
      </head>
      <body className="min-h-full flex flex-col font-body bg-paper text-ink">
        <ThemeProvider>
          {/* Above the theme, so a toast is themed; around everything, so any
              page can raise one without threading a prop to it. */}
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

