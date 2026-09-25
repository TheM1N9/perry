"use client";

import { motion } from "motion/react";

/** The hero headline: each word comes into focus in turn. */
export function BlurWords({ text, className, id = "hero-title" }: { text: string; className?: string; id?: string }) {
  const words = text.split(" ");
  return (
    <h1 id={id} className={className} aria-label={text}>
      {words.map((word, i) => (
        <motion.span
          key={i}
          aria-hidden
          className="inline-block whitespace-pre"
          initial={{ opacity: 0, filter: "blur(10px)", y: "18%" }}
          animate={{ opacity: 1, filter: "blur(0px)", y: 0 }}
          transition={{ duration: 0.8, delay: 0.1 + i * 0.06, ease: [0.25, 0.46, 0.45, 0.94] }}
        >
          {word}
          {i < words.length - 1 ? " " : ""}
        </motion.span>
      ))}
    </h1>
  );
}
