"use client";

import { AnimatePresence, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

/*
 * Perry's mascot: an original teal platypus in a fedora, drawn here so it can
 * move. Its eyes follow the pointer, it blinks, and a click tips the hat and
 * gets a line out of it.
 */

export const TEAL = "#26b5a9";
const TEAL_DARK = "#1b8e85";
const BILL = "#f5a13a";
const BILL_DARK = "#d9822a";
const HAT = "#4b3326";
const HAT_BAND = "#2a1c15";

const QUIPS = [
  "Remembers everything. Tells no one.",
  "I asked first. I always ask first.",
  "Build fixed. Nobody saw a thing.",
  "Undercover since 08:00.",
  "I never go rogue. It's in my contract.",
];

/** The drawing alone, for places that don't move: the favicon, the image cards, small avatars. */
export function PlatypusArt({
  look = { x: 0, y: 0 }, lid = 0.32, hatLift = 0, head = false, className = "",
}: { look?: { x: number; y: number }; lid?: number; hatLift?: number; head?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox={head ? "44 44 152 132" : "0 0 240 262"} className={className} aria-hidden>
      <defs>
        {[100, 140].map((cx) => (
          <clipPath key={cx} id={`${id}-eye-${cx}`}>
            <ellipse cx={cx} cy="116" rx="13" ry="15" />
          </clipPath>
        ))}
        <linearGradient id={`${id}-body`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor={TEAL} />
          <stop offset="1" stopColor={TEAL_DARK} />
        </linearGradient>
      </defs>
      {/* tail, behind the body */}
      <path d="M160 208c34-10 64 2 66 18 2 17-26 24-62 14z" fill={BILL_DARK} />
      <path d="M176 214l40 16M178 226l34 4" stroke="#b86a22" strokeWidth="3" strokeLinecap="round" opacity=".5" />
      {/* body */}
      <path d="M58 152c0-46 28-70 62-70s62 24 62 70v50c0 30-26 42-62 42s-62-12-62-42z" fill={`url(#${id}-body)`} />
      {/* arms */}
      <ellipse cx="60" cy="182" rx="10" ry="20" transform="rotate(12 60 182)" fill={TEAL_DARK} />
      <ellipse cx="180" cy="182" rx="10" ry="20" transform="rotate(-12 180 182)" fill={TEAL_DARK} />
      {/* feet */}
      <ellipse cx="94" cy="246" rx="20" ry="8" fill={BILL} />
      <ellipse cx="146" cy="246" rx="20" ry="8" fill={BILL} />
      {/* eyes */}
      {[100, 140].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy="116" rx="13" ry="15" fill="#fff" />
          <circle cx={cx + look.x * 4} cy={118 + look.y * 4} r="5.6" fill="#101214" />
          <circle cx={cx + look.x * 4 + 1.8} cy={116 + look.y * 4} r="1.6" fill="#fff" />
          {/* the lid: a little lowered is the platypus's usual unimpressed look */}
          <g clipPath={`url(#${id}-eye-${cx})`}>
            <rect x={cx - 15} y="99" width="30" height={34 * lid} fill={TEAL_DARK} />
            <path d={`M${cx - 15} ${99 + 34 * lid}h30`} stroke="#14706a" strokeWidth="2.4" />
          </g>
        </g>
      ))}
      {/* bill */}
      <path d="M70 148c0-12 24-17 50-17s50 5 50 17c0 15-22 21-50 21s-50-6-50-21z" fill={BILL} />
      <path d="M78 156c14 7 70 7 84 0" stroke={BILL_DARK} strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <circle cx="110" cy="141" r="2.2" fill={BILL_DARK} />
      <circle cx="130" cy="141" r="2.2" fill={BILL_DARK} />
      {/* fedora, worn at an angle */}
      <motion.g
        initial={false}
        animate={{ y: -hatLift, rotate: -7 - hatLift * 0.6 }}
        transition={{ type: "spring", stiffness: 380, damping: 18 }}
        style={{ transformOrigin: "120px 90px", transformBox: "view-box" }}
      >
        <ellipse cx="120" cy="89" rx="72" ry="11" fill={HAT} />
        <path d="M84 89c2-26 14-38 26-35 6 2 14 2 20 0 12-3 24 9 26 35z" fill={HAT} />
        <path d="M85 80h70v8H85z" fill={HAT_BAND} />
        <path d="M100 60c6 2 34 2 40 0" stroke="#6a4a37" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      </motion.g>
    </svg>
  );
}

/** The live mascot. */
export function Platypus({
  className = "", quips = true, size = "md", greeting,
}: { className?: string; quips?: boolean; size?: "sm" | "md" | "lg"; greeting?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduced = useReducedMotion();
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [blink, setBlink] = useState(false);
  const [tip, setTip] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const turn = useRef(-1);
  const seen = useInView(ref, { once: true, amount: 0.8 });

  // Eyes follow the pointer anywhere on the page.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height * 0.45);
      const d = Math.max(1, Math.hypot(dx, dy));
      const reach = Math.min(1, d / 260);
      setLook({ x: (dx / d) * reach, y: (dy / d) * reach });
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);

  // A blink every few seconds.
  useEffect(() => {
    if (reduced) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 140);
        next();
      }, 2600 + Math.random() * 3200);
    };
    next();
    return () => clearTimeout(timer);
  }, [reduced]);

  useEffect(() => {
    if (said === null) return;
    const timer = setTimeout(() => setSaid(null), 2800);
    return () => clearTimeout(timer);
  }, [said]);

  const tipHat = () => {
    setTip(true);
    setTimeout(() => setTip(false), 650);
  };

  // Some appearances open with a hat tip and a hello, the first time they're seen.
  useEffect(() => {
    if (!seen || !greeting) return;
    tipHat();
    setSaid(greeting);
  }, [seen, greeting]);

  const poke = () => {
    tipHat();
    if (!quips) return;
    turn.current = (turn.current + 1) % QUIPS.length;
    setSaid(QUIPS[turn.current]);
  };

  const width = size === "lg" ? "w-[220px] md:w-[260px]" : size === "sm" ? "w-[84px]" : "w-[150px]";
  return (
    <div className={`relative ${className}`}>
      <AnimatePresence>
        {said !== null ? (
          <motion.p
            key={said}
            role="status"
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ type: "spring", stiffness: 420, damping: 26 }}
            className="absolute bottom-[92%] left-1/2 z-10 w-max max-w-[240px] -translate-x-1/2 rounded-2xl bg-fg px-3.5 py-2 text-center text-[14px] font-medium leading-snug text-canvas shadow-[0_10px_30px_rgb(0_0_0/0.4)] after:absolute after:left-1/2 after:top-full after:-translate-x-1/2 after:border-8 after:border-transparent after:border-t-fg"
          >
            {said}
          </motion.p>
        ) : null}
      </AnimatePresence>
      <motion.button
        ref={ref}
        type="button"
        onClick={poke}
        aria-label="Perry, the platypus. Poke him."
        className={`block ${width} cursor-pointer rounded-3xl`}
        animate={reduced ? undefined : { y: [0, -3, 0] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        whileTap={{ scale: 0.95 }}
      >
        <PlatypusArt look={look} lid={blink ? 1 : 0.32} hatLift={tip ? 16 : 0} className="h-auto w-full drop-shadow-[0_24px_40px_rgb(0_0_0/0.45)]" />
      </motion.button>
    </div>
  );
}
