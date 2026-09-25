import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { Motion } from "@/components/fx/Motion";
import { SITE } from "@/lib/site";
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
  metadataBase: new URL(SITE),
  title: "Perry: the only AI assistant you need",
  description:
    "Perry lives in your Telegram, remembers you, and gets real work done on your computer.",
  openGraph: {
    title: "Perry",
    description: "The only AI assistant you need.",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#08090a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${interTight.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh overflow-x-clip bg-canvas text-fg">
        <a
          href="#main"
          className="fixed left-3 -top-16 z-50 rounded-lg bg-fg px-3 py-2 font-medium text-canvas focus:top-3"
        >
          Skip to content
        </a>
        <Motion>{children}</Motion>
      </body>
    </html>
  );
}
