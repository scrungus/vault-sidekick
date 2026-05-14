import type { NoteIndex } from "../vault/scanner.js";

/**
 * A hub note declares the journal genre(s) it collects via a nested tag.
 * With the default tag prefix `vsk-hub`, a note tagged `#vsk-hub/dreams`
 * becomes the hub for the "dreams" genre. A note can claim several genres
 * with multiple tags (`#vsk-hub/dreams`, `#vsk-hub/nightmares`).
 *
 * This is opt-in and user-applied — the agent never writes these tags.
 */
export type HubRegistry = Map<string, string>; // genre (lowercased) → note relPath

export function buildHubRegistry(index: NoteIndex, hubTag: string): HubRegistry {
  const byGenre: HubRegistry = new Map();
  const prefix = `${hubTag}/`;
  for (const note of index.notes.values()) {
    for (const tag of note.tags) {
      if (tag.startsWith(prefix)) {
        const genre = tag.slice(prefix.length).trim().toLowerCase();
        if (genre) byGenre.set(genre, note.relPath);
      }
    }
  }
  return byGenre;
}

/** Resolve a genre to a hub note path, case-insensitively. Returns null if no hub claims it. */
export function resolveHub(registry: HubRegistry, genre: string): string | null {
  return registry.get(genre.trim().toLowerCase()) ?? null;
}
