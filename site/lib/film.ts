import { existsSync } from "node:fs";
import { join } from "node:path";

export type FilmFile = { src: string; poster?: string };

/**
 * The commit jsDelivr serves the film from. The film is 5.7 MB, most of what the site would send,
 * so it comes from jsDelivr's CDN out of this repo rather than from Vercel. A commit, not a branch,
 * so jsDelivr can keep it for good. A new film: commit public/film/perry.mp4, then put that commit here.
 */
const FILM_COMMIT = "21404fd50b1b76c445704347bd21ca6589c8f8b7";
export const FILM_CDN = `https://cdn.jsdelivr.net/gh/TheM1N9/perry@${FILM_COMMIT}/site/public/film/perry.mp4`;

/**
 * Perry's film, if there is one: public/film/perry.mp4, played from jsDelivr, with poster.jpg as its
 * first frame from the site itself. Read when the page is built.
 */
export function film(): FilmFile | null {
  const dir = join(process.cwd(), "public", "film");
  if (!existsSync(join(dir, "perry.mp4"))) return null;
  return { src: FILM_CDN, poster: existsSync(join(dir, "poster.jpg")) ? "/film/poster.jpg" : undefined };
}
