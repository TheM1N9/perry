/** Formats safe to render directly on Perry's authenticated origin. */
export function isInlineMedia(contentType: string): boolean {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return /^(image|video|audio)\//.test(mime) && mime !== "image/svg+xml";
}
