import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Meet Perry, the assistant that works on your computer.";
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
          background: "radial-gradient(60% 70% at 30% 0%, #1a1c1f 0%, #08090a 70%)",
          color: "#f7f8f8",
          fontFamily: "Inter Tight",
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 640 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 600 }}>
            <svg width="44" height="44" viewBox="0 0 32 32">
              <rect width="32" height="32" rx="8" fill="#f7f8f8" />
              <path d="M6.5 8.3A2.8 2.8 0 0 1 9.3 5.5h13.4a2.8 2.8 0 0 1 2.8 2.8v9.8a2.8 2.8 0 0 1-2.8 2.8h-7.9l-5.3 4.7v-4.7a2.8 2.8 0 0 1-3-2.8V8.3Z" fill="#08090a" />
              <path d="m11.3 10.3 3 2.4-3 2.4M16.2 15.1h3.7" stroke="#f7f8f8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            Perry
          </div>
          <div style={{ display: "flex", fontSize: 68, fontWeight: 600, lineHeight: 1.04, letterSpacing: "-0.03em" }}>
            Meet Perry, the assistant that works on your computer.
          </div>
          <div style={{ display: "flex", fontSize: 26, color: "#8a8f98" }}>You run your own copy. Nothing phones home.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 10, marginLeft: 48, width: 352 }}>
          <div style={{ display: "flex", alignSelf: "flex-end", background: "#2b5278", borderRadius: 18, padding: "12px 16px", fontSize: 21 }}>
            the build is failing, can you look?
          </div>
          <div style={{ display: "flex", flexDirection: "column", background: "#182533", borderRadius: 18, padding: "14px 16px", fontSize: 21 }}>
            <span style={{ fontWeight: 600 }}>Perry wants to run</span>
            <span style={{ marginTop: 8, padding: "6px 10px", borderRadius: 8, background: "rgba(0,0,0,0.3)", fontSize: 19 }}>pnpm install</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, color: "#4cc97c", fontSize: 19 }}>
              <svg width="16" height="16" viewBox="0 0 16 16"><path d="m3 8.5 3.2 3L13 4.5" stroke="#4cc97c" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Approved by you
            </span>
          </div>
          <div style={{ display: "flex", background: "#182533", borderRadius: 18, padding: "12px 16px", fontSize: 21 }}>
            Fixed. The build passes.
          </div>
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
