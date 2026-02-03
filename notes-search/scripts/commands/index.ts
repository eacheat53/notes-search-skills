/**
 * Index command implementation
 * Builds semantic search index using embeddings
 * 重构版本 - 使用 ChunkManager
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { loadConfig, validateConfig, type Config } from '../config.js';
import { ChunkManager, type Chunk } from '../core/index.js';

export interface IndexOptions {
    notesDir?: string;
    force?: boolean;
}

export interface IndexResponse {
    success: boolean;
    message: string;
    indexed_files: number;
    total_chunks: number;
    index_path: string;
}

/**
 * Build search index
 */
export async function buildIndex(options: IndexOptions): Promise<IndexResponse> {
    const config = loadConfig();

    // Override notes_dir if provided
    if (options.notesDir) {
        config.notes_dir = options.notesDir;
    }

    // Validate config - indexing requires embedding API if enabled
    const errors = validateConfig(config, { requireEmbedding: config.embedding.enabled });
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    // Ensure index directory exists
    if (!fs.existsSync(config.index_dir)) {
        fs.mkdirSync(config.index_dir, { recursive: true });
    }

    const indexPath = path.join(config.index_dir, 'index.json');

    // Check if we need to rebuild
    let oldIndexData: any = null;
    if (!options.force && fs.existsSync(indexPath)) {
        try {
            oldIndexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            console.error(`Loaded existing index with ${oldIndexData.chunks?.length || 0} chunks.`);
        } catch (e) {
            console.error('Failed to load existing index, starting fresh.');
        }
    }

    // Initialize ChunkManager
    const chunkManager = new ChunkManager(config.notes_dir, {
        maxChars: config.chunk_size,
    });

    // Get all markdown files
    const files = await getMarkdownFiles(config);
    const relativePaths = files.map(f => path.relative(config.notes_dir, f));

    // Get chunks using ChunkManager
    console.error(`Parsing ${files.length} files...`);
    const chunks = await chunkManager.getChunks(relativePaths);

    // Prepare for embedding generation
    const indexChunks: (Chunk & { embedding?: number[] })[] = chunks;

    let originalCount = 0;
    let reusedCount = 0;

    // incremental update logic
    if (config.embedding.enabled && oldIndexData && oldIndexData.chunks) {
        // Create a map for fast lookup of existing embeddings
        const oldChunkMap = new Map<string, any>();
        for (const chunk of oldIndexData.chunks) {
            if (chunk.id && chunk.embedding) {
                oldChunkMap.set(chunk.id, chunk);
            }
        }

        // Iterate through new chunks and try to reuse embeddings
        for (const chunk of indexChunks) {
            const oldChunk = oldChunkMap.get(chunk.id);
            if (oldChunk) {
                // If contentHash matches, reuse embedding
                // If old index doesn't have hash (migration), we can't safely reuse unless we trust ID+Content check, 
                // but we don't have full content in old index.
                // So, only reuse if contentHash matches.
                if (oldChunk.contentHash && oldChunk.contentHash === chunk.contentHash) {
                    chunk.embedding = oldChunk.embedding;
                    reusedCount++;
                }
            }
        }
        originalCount = oldChunkMap.size;
    }

    // Filter chunks that need embeddings
    const chunksToEmbed = indexChunks.filter(c => !c.embedding);

    if (config.embedding.enabled) {
        if (chunksToEmbed.length > 0) {
            console.error(`Generating embeddings for ${chunksToEmbed.length} new/modified chunks (Reused ${reusedCount})...`);
            await generateEmbeddings(chunksToEmbed, config);
        } else {
            console.error(`All ${indexChunks.length} chunks are up to date (Reused ${reusedCount}).`);
        }
    }

    // Save index
    const indexData = {
        version: '1.1.0', // Bump version
        created_at: new Date().toISOString(),
        notes_dir: config.notes_dir,
        total_files: files.length,
        total_chunks: chunks.length,
        embedding_enabled: config.embedding.enabled,
        embedding_model: config.embedding.enabled ? config.embedding.model : null,
        chunks: indexChunks.map(c => ({
            id: c.id,
            title: c.title,
            path: c.notePath,
            heading: c.heading,
            tags: c.tags,
            content_preview: c.content.slice(0, 200),
            contentHash: c.contentHash, // Save hash for incremental updates
            embedding: c.embedding,
        })),
    };

    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));

    return {
        success: true,
        message: `Index updated successfully. Processed ${chunks.length} chunks (Generated ${chunksToEmbed.length}, Reused ${reusedCount}).`,
        indexed_files: files.length,
        total_chunks: chunks.length,
        index_path: indexPath,
    };
}

/**
 * Get all markdown files
 */
async function getMarkdownFiles(config: Config): Promise<string[]> {
    const files: string[] = [];

    for (const pattern of config.inclusions) {
        const matches = await glob(pattern, {
            cwd: config.notes_dir,
            ignore: config.exclusions,
            absolute: true,
        });
        files.push(...matches);
    }

    return [...new Set(files)];
}

/**
 * Generate embeddings for chunks
 */
async function generateEmbeddings(chunks: (Chunk & { embedding?: number[] })[], config: Config): Promise<void> {
    const apiKey = process.env[config.embedding.api_key_env];

    if (!apiKey && config.embedding.provider !== 'ollama' && config.embedding.provider !== 'local') {
        throw new Error(`API key not found: ${config.embedding.api_key_env}`);
    }

    // Process in batches
    const batchSize = config.embedding.batch_size;

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map(c => `${c.title}\n${c.heading || ''}\n${c.content}`);

        try {
            const embeddings = await callEmbeddingAPI(texts, config, apiKey);

            for (let j = 0; j < batch.length; j++) {
                batch[j].embedding = embeddings[j];
            }

            // Progress indicator
            console.error(`Indexed ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks`);
        } catch (error) {
            console.error(`Failed to generate embeddings for batch ${i}:`, error);
            throw error;
        }
    }
}

/**
 * Call embedding API
 */
async function callEmbeddingAPI(
    texts: string[],
    config: Config,
    apiKey: string | undefined
): Promise<number[][]> {
    const { provider, model, base_url } = config.embedding;

    let url: string;
    let headers: Record<string, string>;
    let body: any;

    switch (provider) {
        case 'openai':
            url = base_url || 'https://api.openai.com/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = {
                model,
                input: texts,
            };
            break;

        case 'ollama':
            url = base_url || 'http://localhost:11434/api/embeddings';
            headers = { 'Content-Type': 'application/json' };
            // Ollama processes one at a time
            const ollamaResults: number[][] = [];
            for (const text of texts) {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ model, prompt: text }),
                });
                const data = await response.json() as { embedding: number[] };
                ollamaResults.push(data.embedding);
            }
            return ollamaResults;

        case 'local':
            // 本地 FastAPI 服务（OpenAI 兼容格式）
            url = base_url || 'http://localhost:8000/v1/embeddings';
            headers = { 'Content-Type': 'application/json' };
            // input_type: 'passage' 用于文档索引，服务端会添加 "passage: " 前缀
            body = {
                model,
                input: texts,
                input_type: 'passage',
            };
            break;

        case 'cohere':
            url = base_url || 'https://api.cohere.ai/v1/embed';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = {
                model,
                texts,
                input_type: 'search_document',
            };
            break;

        case 'siliconflow':
            url = base_url || 'https://api.siliconflow.cn/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = {
                model,
                input: texts,
            };
            break;

        case 'jina':
            url = base_url || 'https://api.jina.ai/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = {
                model,
                input: texts,
            };
            break;

        default:
            throw new Error(`Unknown embedding provider: ${provider}`);
    }

    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Embedding API error: ${response.status} ${errorText}`);
    }

    const data = await response.json() as any;

    // Extract embeddings based on provider response format
    if (provider === 'openai' || provider === 'siliconflow' || provider === 'jina' || provider === 'local') {
        return data.data.map((d: any) => d.embedding);
    } else if (provider === 'cohere') {
        return data.embeddings;
    }

    return data.embeddings;
}
