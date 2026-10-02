/**
 * The Library's words and kinds (issue #216), shared by the backend
 * (library.ts), Perry's tools and the dashboard.
 */

export type LibraryKind = "image" | "document" | "media" | "other";
export type LibraryBy = "owner" | "perry";
export type LibraryFrom = "web" | "telegram" | "whatsapp" | "pet" | "job" | "task" | "folder";
export type LibraryHow = "upload" | "generated" | "shared" | "written" | "screenshot" | "look" | "added" | "folder";

export const KINDS: Record<LibraryKind, string> = { image: "Images", document: "Documents", media: "Audio and video", other: "Other" };
export const BY: Record<LibraryBy, string> = { owner: "You", perry: "Perry" };
export const FROM: Record<LibraryFrom, string> = {
  web: "Web chat", telegram: "Telegram", whatsapp: "WhatsApp", pet: "Desktop pet", job: "Schedule", task: "Task", folder: "Perry's folder",
};
export const HOW: Record<LibraryHow, string> = {
  upload: "Sent to Perry", generated: "Generated", shared: "Shared in a chat", written: "Written by Perry", screenshot: "Browser screenshot",
  look: "Look at the screen", added: "Added to the Library", folder: "In Perry's files folder",
};

/** The dates the Library filters by: since how long ago, in days. */
export const SINCE = { today: 1, week: 7, month: 31, year: 366 } as const;
export type LibrarySince = keyof typeof SINCE;

const DOCUMENT = /^(text\/|application\/(pdf|json|rtf|xml|msword|vnd\.(openxmlformats|ms-|oasis)))/;
const DOCUMENT_NAME = /\.(pdf|txt|md|markdown|csv|json|rtf|docx?|xlsx?|pptx?|od[tsp]|xml|ya?ml|log|html?)$/i;

export function kindOf(contentType: string, name: string): LibraryKind {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/") || contentType.startsWith("video/")) return "media";
  if (DOCUMENT.test(contentType) || DOCUMENT_NAME.test(name)) return "document";
  return "other";
}

/** How a file can be shown in the item view: as itself, as text, or not at all (download only). */
export function previewOf(contentType: string, name: string): "image" | "video" | "audio" | "pdf" | "markdown" | "text" | null {
  if (contentType === "image/svg+xml") return null;
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "pdf";
  if (contentType === "text/markdown" || /\.(md|markdown)$/i.test(name)) return "markdown";
  if (/^text\/(plain|csv)$/.test(contentType) || contentType === "application/json" || /\.(txt|csv|json|log|ya?ml)$/i.test(name)) return "text";
  return null;
}

/** The address a Library item is served from (app/api/media/library). */
export const libraryFileUrl = (id: string, download = false) => `/api/media/library/${id}${download ? "?download=1" : ""}`;
export const libraryHref = (id: string) => `/library/${id}`;
