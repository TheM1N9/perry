import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Perry, the only AI assistant you need.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// ImageResponse can't read woff2, so the card has its own copies of Inter Tight.
const semibold = await readFile(join(process.cwd(), "app/og/inter-tight-600.woff"));
const regular = await readFile(join(process.cwd(), "app/og/inter-tight-400.woff"));

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#f5f5f7",
          color: "#1d1d1f",
          fontFamily: "Inter Tight",
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 640 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 600 }}>
            Perry
          </div>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 600, lineHeight: 1.04, letterSpacing: "-0.03em" }}>
            The only AI assistant you need.
          </div>
          <div style={{ display: "flex", fontSize: 28, color: "#6e6e73" }}>Lives in your Telegram. Works on your computer.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginLeft: 40, width: 392 }}>
          {/* The mascot, as drawn in components/mascot/Platypus.tsx (static here: no hooks in ImageResponse). */}
          <svg width="360" height="393" viewBox="0 0 240 262">
            <path d="M160 208c34-10 64 2 66 18 2 17-26 24-62 14z" fill="#d9822a" />
            <path d="M58 152c0-46 28-70 62-70s62 24 62 70v50c0 30-26 42-62 42s-62-12-62-42z" fill="#26b5a9" />
            <ellipse cx="60" cy="182" rx="10" ry="20" fill="#1b8e85" />
            <ellipse cx="180" cy="182" rx="10" ry="20" fill="#1b8e85" />
            <ellipse cx="94" cy="246" rx="20" ry="8" fill="#f5a13a" />
            <ellipse cx="146" cy="246" rx="20" ry="8" fill="#f5a13a" />
            <ellipse cx="100" cy="116" rx="13" ry="15" fill="#fff" />
            <ellipse cx="140" cy="116" rx="13" ry="15" fill="#fff" />
            <circle cx="98" cy="120" r="5.6" fill="#101214" />
            <circle cx="138" cy="120" r="5.6" fill="#101214" />
            <path d="M87.5 110a13 15 0 0 1 25 0z" fill="#1b8e85" />
            <path d="M127.5 110a13 15 0 0 1 25 0z" fill="#1b8e85" />
            <path d="M70 148c0-12 24-17 50-17s50 5 50 17c0 15-22 21-50 21s-50-6-50-21z" fill="#f5a13a" />
            <path d="M78 156c14 7 70 7 84 0" stroke="#d9822a" strokeWidth="2.6" strokeLinecap="round" fill="none" />
            <g transform="rotate(-7 120 90)">
              <ellipse cx="120" cy="89" rx="72" ry="11" fill="#4b3326" />
              <path d="M84 89c2-26 14-38 26-35 6 2 14 2 20 0 12-3 24 9 26 35z" fill="#4b3326" />
              <path d="M85 80h70v8H85z" fill="#2a1c15" />
            </g>
          </svg>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Inter Tight", data: semibold, weight: 600, style: "normal" },
        { name: "Inter Tight", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
