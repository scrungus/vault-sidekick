import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { create, insertMultiple, search } from "@orama/orama";
import type { AnyOrama } from "@orama/orama";

interface VaultContextChunk {
  index: number;
  content: string;
  embedding: number[];
}

interface VaultContextDoc {
  path: string;
  hash: string;
  title: string;
  outgoing_links: string[];
  backlinks: string[];
  tags: string[];
  chunks: VaultContextChunk[];
}

export interface ChunkRecord {
  id: string;
  source_path: string;
  title: string;
  content: string;
  chunk_index: number;
  embedding: number[];
}

export interface EmbeddingStore {
  db: AnyOrama;
  numNotes: number;
  numChunks: number;
  dim: number;
  missingPaths: string[];
  chunks: ChunkRecord[];
}

export interface NearChunk {
  id: string;
  source_path: string;
  title: string;
  content: string;
  chunk_index: number;
  score: number;
}

export async function loadEmbeddings(opts: {
  embeddingsDir: string;
  knownPaths: Iterable<string>;
}): Promise<EmbeddingStore> {
  const dir = opts.embeddingsDir;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Embeddings dir not found: ${dir}. Have you opened Obsidian with vault-context installed?`,
      );
    }
    throw err;
  }
  const jsonFiles = entries.filter((f) => f.endsWith(".json"));

  let dim = 0;
  const records: ChunkRecord[] = [];
  const embeddedPaths = new Set<string>();

  for (const f of jsonFiles) {
    const raw = await readFile(join(dir, f), "utf-8");
    let doc: VaultContextDoc;
    try {
      doc = JSON.parse(raw) as VaultContextDoc;
    } catch {
      continue;
    }
    if (!doc.chunks || doc.chunks.length === 0) continue;
    embeddedPaths.add(doc.path);
    for (const chunk of doc.chunks) {
      if (!chunk.embedding || chunk.embedding.length === 0) continue;
      if (dim === 0) dim = chunk.embedding.length;
      records.push({
        id: `${doc.path}::${chunk.index}`,
        source_path: doc.path,
        title: doc.title,
        content: chunk.content,
        chunk_index: chunk.index,
        embedding: chunk.embedding,
      });
    }
  }

  if (dim === 0) {
    throw new Error("No embeddings found — every JSON file was empty or unreadable.");
  }

  const db = create({
    schema: {
      id: "string",
      source_path: "string",
      title: "string",
      content: "string",
      chunk_index: "number",
      embedding: `vector[${dim}]`,
    },
  }) as AnyOrama;

  // Orama mutates the `embedding` field of matched documents to `null` after a
  // vector search (a return-side optimization). If we share array references
  // with records, our local copy gets nulled out. Give Orama its own copies.
  const oramaDocs = records.map((r) => ({ ...r, embedding: r.embedding.slice() }));
  await insertMultiple(db, oramaDocs as unknown as Record<string, unknown>[]);

  const missingPaths: string[] = [];
  for (const p of opts.knownPaths) {
    if (!embeddedPaths.has(p)) missingPaths.push(p);
  }

  return {
    db,
    numNotes: embeddedPaths.size,
    numChunks: records.length,
    dim,
    missingPaths,
    chunks: records,
  };
}

export async function findNearChunks(
  store: EmbeddingStore,
  queryEmbedding: number[],
  opts: { limit: number; minSimilarity?: number; excludeSourcePath?: string },
): Promise<NearChunk[]> {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length !== store.dim) {
    throw new Error(
      `bad query embedding: type=${typeof queryEmbedding}, isArray=${Array.isArray(queryEmbedding)}, len=${(queryEmbedding as unknown as { length?: number })?.length}, expected dim=${store.dim} (from source=${opts.excludeSourcePath})`,
    );
  }
  const result = await search(store.db, {
    mode: "vector",
    vector: { value: queryEmbedding, property: "embedding" },
    limit: opts.limit + (opts.excludeSourcePath ? 5 : 0),
    similarity: opts.minSimilarity ?? 0,
  });
  const hits: NearChunk[] = [];
  for (const hit of result.hits) {
    const doc = hit.document as unknown as ChunkRecord;
    if (opts.excludeSourcePath && doc.source_path === opts.excludeSourcePath) continue;
    hits.push({
      id: doc.id,
      source_path: doc.source_path,
      title: doc.title,
      content: doc.content,
      chunk_index: doc.chunk_index,
      score: hit.score,
    });
    if (hits.length >= opts.limit) break;
  }
  return hits;
}
