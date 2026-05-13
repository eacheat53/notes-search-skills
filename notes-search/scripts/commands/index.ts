/**
 * Index command implementation
 * 使用 SQLite 存储索引数据（替代 JSON）
 */

import * as path from 'path';
import { glob } from 'glob';
import { loadConfig, validateConfig, type Config } from '../config.js';
import { ChunkManager, IndexStore, type Chunk, type IndexedChunk } from '../core/index.js';

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

    // Validate config
    const errors = validateConfig(config, { requireEmbedding: config.embedding.enabled });
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    // 打开 SQLite 索引
    const store = new IndexStore(config.index_dir);

    // 获取已有 chunk 的 hash（用于增量更新）
    let existingHashes = new Map<string, { contentHash: string; hasEmbedding: boolean }>();
    if (!options.force) {
        existingHashes = store.getExistingHashes();
        if (existingHashes.size > 0) {
            console.error(`Loaded existing index with ${existingHashes.size} chunks.`);
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

    // 转换为 IndexedChunk 并复用已有 embedding
    const indexedChunks: IndexedChunk[] = [];
    let reusedCount = 0;

    for (const chunk of chunks) {
        const existing = existingHashes.get(chunk.id);
        let embedding: number[] | undefined;

        if (existing && existing.contentHash === chunk.contentHash && existing.hasEmbedding) {
            // 内容未变且有 embedding，复用
            embedding = store.getEmbedding(chunk.id) || undefined;
            if (embedding) reusedCount++;
        }

        indexedChunks.push({
            id: chunk.id,
            title: chunk.title,
            path: chunk.notePath,
            heading: chunk.heading,
            breadcrumb: (chunk as any).breadcrumb || '',
            tags: chunk.tags,
            content: chunk.content,
            contentHash: chunk.contentHash,
            embedding,
        });
    }

    // 写入 SQLite（事务，极快）
    console.error(`Writing ${indexedChunks.length} chunks to SQLite...`);
    store.saveChunks(indexedChunks);

    // 生成缺失的 embeddings
    const chunksNeedingEmbedding = indexedChunks.filter(c => !c.embedding);

    if (config.embedding.enabled && chunksNeedingEmbedding.length > 0) {
        console.error(
            `Generating embeddings for ${chunksNeedingEmbedding.length} chunks (Reused ${reusedCount})...`
        );
        await generateAndSaveEmbeddings(chunksNeedingEmbedding, store, config);
    } else if (config.embedding.enabled) {
        console.error(`All ${indexedChunks.length} chunks are up to date (Reused ${reusedCount}).`);
    }

    // 保存元数据
    store.setMeta({
        version: '2.0.0',
        created_at: new Date().toISOString(),
        notes_dir: config.notes_dir,
        total_files: files.length,
        total_chunks: chunks.length,
        embedding_enabled: config.embedding.enabled,
        embedding_model: config.embedding.enabled ? config.embedding.model : null,
    });

    const stats = store.getStats();
    store.close();

    const dbPath = path.join(config.index_dir, 'index.db');

    return {
        success: true,
        message: `Index updated. ${chunks.length} chunks (Generated ${chunksNeedingEmbedding.length}, Reused ${reusedCount}). DB size: ${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)}MB`,
        indexed_files: files.length,
        total_chunks: chunks.length,
        index_path: dbPath,
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
 * 生成 embedding 并实时写入 SQLite
 */
async function generateAndSaveEmbeddings(
    chunks: IndexedChunk[],
    store: IndexStore,
    config: Config
): Promise<void> {
    const apiKey = process.env[config.embedding.api_key_env];

    if (!apiKey && config.embedding.provider !== 'ollama' && config.embedding.provider !== 'local') {
        throw new Error(`API key not found: ${config.embedding.api_key_env}`);
    }

    const batchSize = config.embedding.batch_size;

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const texts = batch.map(c => `${c.title}\n${c.heading || ''}\n${c.content}`);

        try {
            const embeddings = await callEmbeddingAPI(texts, config, apiKey);

            // 实时写入 SQLite（每批次一个事务）
            const updates = batch.map((chunk, j) => ({
                id: chunk.id,
                embedding: embeddings[j],
            }));
            store.updateEmbeddings(updates);

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
            body = { model, input: texts };
            break;

        case 'ollama':
            url = base_url || 'http://localhost:11434/api/embeddings';
            headers = { 'Content-Type': 'application/json' };
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
            url = base_url || 'http://localhost:8000/v1/embeddings';
            headers = { 'Content-Type': 'application/json' };
            body = { model, input: texts, input_type: 'passage' };
            break;

        case 'cohere':
            url = base_url || 'https://api.cohere.ai/v1/embed';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, texts, input_type: 'search_document' };
            break;

        case 'siliconflow':
            url = base_url || 'https://api.siliconflow.cn/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, input: texts };
            break;

        case 'jina':
            url = base_url || 'https://api.jina.ai/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, input: texts };
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

    if (provider === 'openai' || provider === 'siliconflow' || provider === 'jina' || provider === 'local') {
        return data.data.map((d: any) => d.embedding);
    } else if (provider === 'cohere') {
        return data.embeddings;
    }

    return data.embeddings;
}
