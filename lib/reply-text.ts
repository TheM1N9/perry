/** A reply's private memory footer is metadata, not part of its displayed text. */
const CITED = /\n?[ \t]*memories:[ \t]*([a-z0-9][a-z0-9, \t]*)\s*$/i;

export function citedMemories(response?: string): { text?: string; ids: string[] } {
  if (response === undefined) return { ids: [] };
  const match = CITED.exec(response);
  if (!match) return { text: response, ids: [] };
  return { text: response.slice(0, match.index).trimEnd(), ids: match[1].split(/[\s,]+/).filter(Boolean) };
}
