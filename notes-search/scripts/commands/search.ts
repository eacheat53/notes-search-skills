/**
 * Search command implementation
 * 
 * 优化：从 SQLite 索引加载数据，不再每次读 HDD 文件。
 * - hybrid/semantic：从 index.db 加载（毫秒级）
 * - lexical：优先从 index.db 加载，无索引时回退读文件
 */

import * as path from 'path';
import { glob } from 'glob';
import { loadConfig, validateConfig, type Config } from '../config.js';
import {
    ChunkManager,
    FullTextEngine,
    IndexStore,
    normalizeScores,
    rrfFusion,
    cosineSimilarity,
    type Chunk,
    type IndexedChunk,
    type SearchHit,
    type MatchExplanation,
} from '../core/index.js';

export interface SearchOptions {
    query: string;
    mode: 'lexical' | 'semantic' | 'hybrid';
    maxResults: number;
    threshold: number;
    tags?: string[];
    notesDir?: string;
    explain?: boolean;
    chunkSize?: number;
}

export interface SearchResult {
    id: string;
    title: string;
    path: string;
    content: string;
    score: number;
    tags: string[];
    heading?: string;
    explanation?: MatchExplanation;
}

export interface SearchResponse {
    results: SearchResult[];
    query: string;
    mode: string;
    total_found: number;
    meta: {
        totalChunks: number;
        searchTimeMs: number;
        source: 'sqlite' | 'files';
    };
}

/**
 * 将 IndexedChunk 转为 Chunk（供 FullTextEngine 使用）
 */
function toChunk(ic: IndexedChunk): Chunk {
    return {
        id: ic.id,
        notePath: ic.path,
        chunkIndex: parseInt(ic.id.split('#')[1] || '0', 10),
        content: ic.content,
        contentHash: ic.contentHash,
        title: ic.title,
        heading: ic.heading,
        breadcrumb: ic.breadcrumb || '',
        tags: ic.tags,
        mtime: 0,
    };
}

/**
 * 主搜索函数
 */
export async function searchNotes(options: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();
    const config = loadConfig();

    if (options.notesDir) {
        config.notes_dir = options.notesDir;
    }

    const errors = validateConfig(config);
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    // 尝试打开 SQLite 索引
    let store: IndexStore | null = null;
    try {
        store = new IndexStore(config.index_dir);
        const meta = store.getMeta();
        if (!meta) {
            store.close();
            store = null;
        }
    } catch {
        store = null;
    }

    let chunks: Chunk[];
    let indexedChunks: IndexedChunk[] | null = null;
    let dataSource: 'sqlite' | 'files';

    if (store) {
        // 从 SQLite 加载（毫秒级）
        if (options.mode === 'semantic' || options.mode === 'hybrid') {
            // 需要 embedding
            console.error('Loading chunks with embeddings from SQLite...');
            indexedChunks = store.getAllChunksWithEmbeddings();
        } else {
            // 词法搜索，不需要 embedding
            console.error('Loading chunks from SQLite (light)...');
            indexedChunks = store.getAllChunksLight();
        }
        chunks = indexedChunks.map(toChunk);
        dataSource = 'sqlite';
        console.error(`Loaded ${chunks.length} chunks from SQLite`);
    } else {
        // 回退：从文件读取
        console.error('No SQLite index found, reading files from disk...');
        const chunkManager = new ChunkManager(config.notes_dir, {
            maxChars: options.chunkSize || config.chunk_size,
        });
        const files = await getMarkdownFiles(config);
        const relativePaths = files.map(f => path.relative(config.notes_dir, f));
        chunks = await chunkManager.getChunks(relativePaths);
        dataSource = 'files';
    }

    // 执行搜索
    let results: SearchResult[];

    switch (options.mode) {
        case 'lexical':
            results = await lexicalSearch(options.query, chunks, config, options);
            break;
        case 'semantic':
            results = await semanticSearch(options.query, indexedChunks, config, options);
            break;
        case 'hybrid':
            results = await hybridSearch(options.query, chunks, indexedChunks, config, options);
            break;
        default:
            throw new Error(`Unknown search mode: ${options.mode}`);
    }

    // 关闭数据库
    if (store) store.close();

    // 应用标签过滤
    if (options.tags && options.tags.length > 0) {
        results = results.filter(r =>
            options.tags!.some(tag => r.tags.includes(tag))
        );
    }

    // 应用阈值和限制
    results = results
        .filter(r => r.score >= options.threshold)
        .slice(0, options.maxResults);

    // 如果不需要解释，移除 explanation
    if (!options.explain) {
        results = results.map(r => {
            const { explanation, ...rest } = r;
            return rest;
        });
    }

    return {
        results,
        query: options.query,
        mode: options.mode,
        total_found: results.length,
        meta: {
            totalChunks: chunks.length,
            searchTimeMs: Date.now() - startTime,
            source: dataSource,
        },
    };
}

/**
 * 词法搜索
 */
async function lexicalSearch(
    query: string,
    chunks: Chunk[],
    config: Config,
    options: SearchOptions
): Promise<SearchResult[]> {
    const engine = new FullTextEngine();
    engine.buildIndex(chunks);

    const hits = engine.search(query, options.maxResults * 2);

    return hits.map(hit => {
        const chunk = chunks.find(c => c.id === hit.id);
        return {
            id: hit.id,
            title: chunk?.title || '',
            path: chunk?.notePath || '',
            content: truncateContent(chunk?.content || '', 2000),
            score: hit.score,
            tags: chunk?.tags || [],
            heading: chunk?.heading,
            explanation: hit.explanation,
        };
    });
}

/**
 * 语义搜索 — 使用 SQLite 中的嵌入向量
 */
async function semanticSearch(
    query: string,
    indexedChunks: IndexedChunk[] | null,
    config: Config,
    options: SearchOptions
): Promise<SearchResult[]> {
    if (!config.embedding.enabled) {
        throw new Error('Semantic search requires embeddings. Run "index" first.');
    }

    if (!indexedChunks) {
        throw new Error('Index not found. Run "notes-search index" to build it.');
    }

    const hasEmbeddings = indexedChunks.some(c => c.embedding && c.embedding.length > 0);
    if (!hasEmbeddings) {
        throw new Error('Index has no embeddings. Rebuild with embedding enabled.');
    }

    const queryEmbedding = await getQueryEmbedding(query, config);

    const results: Array<{ score: number; chunk: IndexedChunk }> = [];

    for (const chunk of indexedChunks) {
        if (!chunk.embedding || chunk.embedding.length === 0) continue;
        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        results.push({ score: similarity, chunk });
    }

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, options.maxResults * 2);

    return topResults.map(r => ({
        id: r.chunk.id,
        title: r.chunk.title || '',
        path: r.chunk.path || '',
        content: truncateContent(r.chunk.content || '', 2000),
        score: r.score,
        tags: r.chunk.tags || [],
        heading: r.chunk.heading,
        explanation: {
            lexicalMatches: [],
            baseScore: r.score,
            finalScore: r.score,
        },
    }));
}

/**
 * 混合搜索 - RRF 融合 + Rerank
 */
async function hybridSearch(
    query: string,
    chunks: Chunk[],
    indexedChunks: IndexedChunk[] | null,
    config: Config,
    options: SearchOptions
): Promise<SearchResult[]> {
    const lexicalResults = await lexicalSearch(query, chunks, config, options);

    let semanticResults: SearchResult[] = [];
    if (config.embedding.enabled && indexedChunks) {
        try {
            semanticResults = await semanticSearch(query, indexedChunks, config, options);
            console.error(`Semantic search returned ${semanticResults.length} results`);
        } catch (err) {
            console.error(`⚠ Semantic search FAILED: ${(err as Error).message}`);
            // 降级为纯词法搜索
        }
    }

    const fused = rrfFusion(
        lexicalResults,
        semanticResults,
        60,
        config.hybrid.lexical_weight,
        config.hybrid.semantic_weight
    );

    let results = fused.map(f => ({
        ...f.result,
        score: f.rrfScore,
        explanation: {
            lexicalMatches: f.result.explanation?.lexicalMatches || [],
            baseScore: f.rrfScore,
            finalScore: f.rrfScore,
        },
    }));

    // Rerank
    if (config.rerank.enabled) {
        try {
            const candidates = results.slice(0, Math.max(options.maxResults * 4, 20));
            results = await rerankResults(query, candidates, config);
        } catch (err) {
            console.error(`Rerank failed: ${(err as Error).message}`);
        }
    }

    const normalized = normalizeScores(results);

    return normalized.map(r => {
        if (r.explanation) {
            return { ...r, explanation: { ...r.explanation, finalScore: r.score } };
        }
        return r;
    });
}

// ===== Utility functions =====

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

async function rerankResults(
    query: string,
    candidates: SearchResult[],
    config: Config
): Promise<SearchResult[]> {
    if (candidates.length === 0) return candidates;

    const documents = candidates.map(c => ({ id: c.id, text: c.content }));

    const response = await fetch(config.rerank.base_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query,
            documents,
            top_n: config.rerank.top_n,
            model: config.rerank.model,
        }),
    });

    if (!response.ok) throw new Error(`Rerank API error: ${response.status}`);

    const data = await response.json() as {
        results: Array<{ index: number; relevance_score: number }>;
    };

    return data.results.map(r => {
        const original = candidates[r.index];
        return {
            ...original,
            score: r.relevance_score,
            explanation: {
                lexicalMatches: original.explanation?.lexicalMatches || [],
                baseScore: original.score,
                finalScore: r.relevance_score,
            },
        };
    });
}

async function getQueryEmbedding(query: string, config: Config): Promise<number[]> {
    const apiKey = process.env[config.embedding.api_key_env];
    const { provider, model, base_url } = config.embedding;

    if (!apiKey && provider !== 'ollama' && provider !== 'local') {
        throw new Error(`API key not found: ${config.embedding.api_key_env}`);
    }

    let url: string;
    let headers: Record<string, string>;
    let body: any;

    switch (provider) {
        case 'local':
            url = base_url || 'http://localhost:8000/v1/embeddings';
            headers = { 'Content-Type': 'application/json' };
            body = { model, input: [query], input_type: 'query' };
            break;
        case 'openai':
        case 'siliconflow':
        case 'jina':
            url = base_url || `https://api.${provider === 'openai' ? 'openai.com' : provider === 'siliconflow' ? 'siliconflow.cn' : 'jina.ai'}/v1/embeddings`;
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            body = { model, input: [query] };
            break;
        case 'ollama':
            url = base_url || 'http://localhost:11434/api/embeddings';
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: query }),
            });
            return ((await resp.json()) as { embedding: number[] }).embedding;
        case 'cohere':
            url = base_url || 'https://api.cohere.ai/v1/embed';
            headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
            body = { model, texts: [query], input_type: 'search_query' };
            break;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Embedding API error: ${response.status}`);
    const data = await response.json() as any;

    if (provider === 'cohere') return data.embeddings[0];
    return data.data[0].embedding;
}

function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...';
}
