"use client";

import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { FilmFile } from "@/lib/film";

/**
 * The film, right on the page. It plays by itself, muted (the only way
 * browsers allow a video to start on its own), and pauses while it's off
 * screen; "Play with sound" starts it over with audio and the browser's own
 * controls.
 */
export function FilmSection({ film }: { film: FilmFile | null }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const inView = useInView(box, { amount: 0.4 });
  const [sound, setSound] = useState(false);

  // The silent film follows the screen; once there's sound, the controls are the viewer's.
  useEffect(() => {
    const el = video.current;
    if (!el || sound) return;
    el.muted = true;
    if (inView) el.play().catch(() => {});
    else el.pause();
  }, [inView, sound]);

  const playWithSound = () => {
    const el = video.current;
    if (!el) return;
    el.muted = false;
    el.loop = false;
    el.controls = true;
    el.currentTime = 0;
    el.play().catch(() => {});
    setSound(true);
  };

  if (!film) return null;
  return (
    <section id="film" aria-label="Perry, the film" className="bg-paper">
      <div ref={box} className="mx-auto max-w-[1180px] px-6 pb-28 md:pb-36">
        <div className="relative overflow-hidden rounded-[28px] bg-black shadow-[0_40px_90px_-40px_rgb(0_0_0/0.5)]">
          <video
            id="perry-film"
            ref={video}
            src={film.src}
            poster={film.poster}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            className="block aspect-video w-full"
          />
          {sound ? null : (
            <button
              type="button"
              onClick={playWithSound}
              className="absolute bottom-5 left-5 inline-flex h-11 items-center gap-2 rounded-full bg-white/90 px-5 text-[15px] font-semibold text-ink shadow-[0_8px_24px_rgb(0_0_0/0.25)] backdrop-blur transition-colors hover:bg-white md:bottom-7 md:left-7"
            >
              <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 5 6 9H2v6h4l5 4V5Z" fill="currentColor" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
              </svg>
              Play with sound
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
