import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

const interTight = localFont({
  src: [
    { path: "./fonts/inter-tight-latin-wght-normal.woff2", style: "normal" },
    { path: "./fonts/inter-tight-latin-wght-italic.woff2", style: "italic" },
  ],
  weight: "100 900",
  variable: "--font-inter-tight",
  display: "swap",
});

const jetbrains = localFont({
  src: "./fonts/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Perry", template: "%s · Perry" },
  description: "Your personal assistant, on your own computer.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0e" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes sets the theme class before paint, so the server's html differs by design.
    <html lang="en" className={`${interTight.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
