import { existsSync } from "node:fs";
import { join } from "node:path";

export type FilmFile = { src: string; poster?: string };

/**
 * Perry's film, if there is one: public/film/perry.mp4, with poster.jpg as its
 * first frame. Read when the page is built, so dropping the file in is enough.
 */
export function film(): FilmFile | null {
  const dir = join(process.cwd(), "public", "film");
  if (!existsSync(join(dir, "perry.mp4"))) return null;
  return { src: "/film/perry.mp4", poster: existsSync(join(dir, "poster.jpg")) ? "/film/poster.jpg" : undefined };
}
