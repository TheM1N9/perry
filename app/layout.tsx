import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Perry",
  description: "A personal assistant that lives in your chat app.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0b0b0c",
          color: "#e8e8ea",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
