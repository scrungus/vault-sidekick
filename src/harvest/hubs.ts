import type { NoteIndex } from "../vault/scanner.js";

/**
 * A hub note declares the journal genre(s) it collects via a frontmatter key
 * (default `vsk-hub`). The value may be a single string or a list:
 *
 *   ---
 *   vsk-hub: dreams
 *   ---
 *
 *   ---
 *   vsk-hub: [dreams, nightmares]
 *   ---
 *
 * This is opt-in and user-applied — the agent never writes this property.
 */
export type HubRegistry = Map<string, string>; // genre (lowercased) → note relPath

export function buildHubRegistry(index: NoteIndex, hubProperty: string): HubRegistry {
  const byGenre: HubRegistry = new Map();
  for (const note of index.notes.values()) {
    const fm = note.frontmatter;
    if (!fm) continue;
    const val = fm[hubProperty];
    if (typeof val === "string") {
      const genre = val.trim().toLowerCase();
      if (genre) byGenre.set(genre, note.relPath);
    } else if (Array.isArray(val)) {
      for (const g of val) {
        if (typeof g === "string") {
          const genre = g.trim().toLowerCase();
          if (genre) byGenre.set(genre, note.relPath);
        }
      }
    }
  }
  return byGenre;
}

/** Resolve a genre to a hub note path, case-insensitively. Returns null if no hub claims it. */
export function resolveHub(registry: HubRegistry, genre: string): string | null {
  return registry.get(genre.trim().toLowerCase()) ?? null;
}
