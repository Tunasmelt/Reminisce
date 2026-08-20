import { getServiceSupabase } from './supabase'

/**
 * Split text into overlapping chunks for embedding.
 * target chunkSize: ~1600 chars (~400 tokens)
 * overlap: 200 chars
 */
export function chunkText(
  text: string,
  chunkSize: number = 1600,
  overlap: number = 200,
): string[] {
  if (!text) return []
  if (text.length <= chunkSize) return [text]

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length)
    const chunk = text.slice(start, end)
    chunks.push(chunk)

    // Move forward by chunk size minus overlap
    start += (chunkSize - overlap)

    // Safety break
    if (start >= text.length - overlap && start < text.length) {
      const finalChunk = text.slice(start)
      if (finalChunk.length > overlap) {
        chunks.push(finalChunk)
      }
      break
    }
  }

  return chunks
}

/**
 * Generate embedding for a single text chunk using OpenAI text-embedding-3-small.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('[vector-memory] OpenAI error:', error)
      return null
    }

    const data = await response.json()
    return data.data[0].embedding
  } catch (err) {
    console.error('[vector-memory] Network error generating embedding:', err)
    return null
  }
}

/**
 * Upsert memory chunks for a source.
 * Replaces all existing chunks for this source_id.
 */
export async function upsertMemoryChunks(
  projectId: string,
  userId: string,
  sourceType: 'context_file' | 'pam_thread' | 'blueprint' | 'codebase',
  sourceId: string,
  content: string,
  sourcePath?: string,
): Promise<{ chunksWritten: number; embedded: boolean }> {
  try {
    const supabase = getServiceSupabase()

    // CE-12: Insert-before-delete pattern — capture existing chunk IDs first,
    // insert the new chunks, and only delete the old ones if the insert
    // succeeds. This prevents a window where a concurrent search sees zero
    // results because the old chunks were deleted before the new ones landed.
    const { data: existingRows } = await supabase
      .from('memory_chunks')
      .select('id')
      .eq('source_id', sourceId)
    const existingIds = (existingRows ?? []).map(r => r.id as string)

    // Chunk text
    const chunks = chunkText(content)
    if (chunks.length === 0) {
      // Nothing to index — clean up stale rows if any
      if (existingIds.length > 0) {
        const { error: delErr } = await supabase
          .from('memory_chunks')
          .delete()
          .in('id', existingIds)
        if (delErr) console.error('[vector-memory] cleanup of stale chunks failed:', delErr)
      }
      return { chunksWritten: 0, embedded: false }
    }

    // Generate embeddings & build rows
    let embeddedCount = 0
    const rows = await Promise.all(chunks.map(async (chunk, index) => {
      const embedding = await generateEmbedding(chunk)
      if (embedding) embeddedCount++

      return {
        project_id: projectId,
        user_id: userId,
        source_type: sourceType,
        source_id: sourceId,
        source_path: sourcePath,
        chunk_index: index,
        content: chunk,
        embedding: embedding,
      }
    }))

    // Insert new chunks first
    const { error: insertErr } = await supabase.from('memory_chunks').insert(rows)
    if (insertErr) throw insertErr

    // CE-12: Only delete old chunks after the insert succeeds — avoids an
    // empty search window on partial failure.
    if (existingIds.length > 0) {
      const { error: delErr } = await supabase
        .from('memory_chunks')
        .delete()
        .in('id', existingIds)
      if (delErr) {
        // Non-fatal: new chunks are already live; stale rows are just duplicates.
        console.error('[vector-memory] failed to clean up old chunks (non-fatal):', delErr)
      }
    }

    return {
      chunksWritten: chunks.length,
      embedded: embeddedCount === chunks.length
    }
  } catch (err) {
    console.error('[vector-memory] Failed to upsert chunks:', err)
    return { chunksWritten: 0, embedded: false }
  }
}

/**
 * Semantic search for most relevant memory chunks.
 */
export async function searchMemory(
  projectId: string,
  query: string,
  limit: number = 5,
  sourceTypes?: Array<'context_file' | 'pam_thread' | 'blueprint' | 'codebase'>,
): Promise<Array<{
  content:     string
  sourceType:  string
  sourcePath?: string
  similarity:  number
}>> {
  try {
    const supabase = getServiceSupabase()
    const embedding = await generateEmbedding(query)

    if (embedding) {
      // ── SEMANTIC SEARCH (vector) ───────────────────────────────────────────
      const { data, error } = await supabase.rpc('match_memory_chunks', {
        query_embedding: embedding,
        match_threshold: 0.3, // fairly generous
        match_count: limit,
        p_project_id: projectId,
        p_source_types: sourceTypes,
      })

      if (error) throw error
      return (data || []).map((row: Record<string, unknown>) => ({
        content: row.content,
        sourceType: row.source_type,
        sourcePath: row.source_path,
        similarity: row.similarity,
      }))
    } else {
      // ── FALLBACK: BASIC TEXT SEARCH ────────────────────────────────────────
      // CE-19: Sanitize ilike wildcards — `%` and `_` are Postgres pattern
      // characters that would cause unexpected broad matches. `\` is the
      // escape character and must also be escaped.
      const sanitizedQuery = query
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')

      const { data, error } = await supabase
        .from('memory_chunks')
        .select('content, source_type, source_path')
        .eq('project_id', projectId)
        .ilike('content', `%${sanitizedQuery}%`)
        .limit(limit)

      if (error) throw error
      return (data || []).map((row: Record<string, unknown>) => ({
        content: String(row.content ?? ''),
        sourceType: String(row.source_type ?? ''),
        sourcePath: row.source_path as string | undefined,
        similarity: 0.5, // placeholder for text match
      }))
    }
  } catch (err) {
    console.error('[vector-memory] Search failed:', err)
    return []
  }
}

/**
 * Index all context files for a project.
 * CE-20: Uses parallel batches of 3 (Promise.allSettled) instead of a fully
 * sequential loop — reduces total time proportionally while staying well
 * within OpenAI's embedding rate limits (~3000 RPM for text-embedding-3-small).
 */
export async function indexProjectContext(
  projectId: string,
  userId: string,
): Promise<void> {
  try {
    const supabase = getServiceSupabase()

    // Load all context files
    const { data: contexts, error } = await supabase
      .from('contexts')
      .select('id, file_path, content')
      .eq('project_id', projectId)

    if (error) throw error
    if (!contexts || contexts.length === 0) return

    // CE-20: Process in batches of 3 — parallelises within each batch while
    // leaving headroom for other concurrent API calls.
    const BATCH_SIZE = 3
    for (let i = 0; i < contexts.length; i += BATCH_SIZE) {
      const batch = contexts.slice(i, i + BATCH_SIZE)
      await Promise.allSettled(
        batch.map(context =>
          upsertMemoryChunks(
            projectId,
            userId,
            'context_file',
            context.id,
            context.content || '',
            context.file_path,
          ),
        ),
      )
    }
  } catch (err) {
    console.error('[vector-memory] Project indexing failed:', err)
  }
}
