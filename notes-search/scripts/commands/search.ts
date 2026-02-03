/**
 * Search command implementation
 * 重构版本 - 使用核心模块
 * 
 * 参考 obsidian-copilot/src/search/v3/TieredLexicalRetriever.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { loadConfig, validateConfig, type Config } from '../config.js';
import {
    ChunkManager,
    FullTextEngine,
    normalizeScores,
    rrfFusion,
    cosineSimilarity,
    type Chunk,
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
    /** 分块 ID */
    id: string;
    /** 笔记标题 */
    title: string;
    /** 笔记路径 */
    path: string;
    /** 内容片段 */
    content: string;
    /** 相关性分数 (0-1) */
    score: number;
    /** 标签列表 */
    tags: string[];
    /** 章节标题 */
    heading?: string;
    /** 匹配解释（当 explain=true 时） */
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
    };
}

/**
 * 主搜索函数
 */
export async function searchNotes(options: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();
    const config = loadConfig();

    // 覆盖配置
    if (options.notesDir) {
        config.notes_dir = options.notesDir;
    }

    // 验证配置
    const requireEmbedding = options.mode === 'semantic' || options.mode === 'hybrid';
    const errors = validateConfig(config, { requireEmbedding });
    if (errors.length > 0) {
        throw new Error(errors.join('\n'));
    }

    // 创建分块管理器
    const chunkManager = new ChunkManager(config.notes_dir, {
        maxChars: options.chunkSize || config.chunk_size,
    });

    // 获取所有笔记文件
    const files = await getMarkdownFiles(config);
    const relativePaths = files.map(f => path.relative(config.notes_dir, f));

    // 获取所有分块
    const chunks = await chunkManager.getChunks(relativePaths);

    // 执行搜索
    let results: SearchResult[];

    switch (options.mode) {
        case 'lexical':
            results = await lexicalSearch(options.query, chunks, config, options);
            break;
        case 'semantic':
            results = await semanticSearch(options.query, chunks, config, options);
            break;
        case 'hybrid':
            results = await hybridSearch(options.query, chunks, config, options);
            break;
        default:
            throw new Error(`Unknown search mode: ${options.mode}`);
    }

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

    // 如果不需要解释，移除 explanation 字段
    if (!options.explain) {
        results = results.map(r => {
            const { explanation, ...rest } = r;
            return rest;
        });
    }

    const endTime = Date.now();

    return {
        results,
        query: options.query,
        mode: options.mode,
        total_found: results.length,
        meta: {
            totalChunks: chunks.length,
            searchTimeMs: endTime - startTime,
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
    // 构建全文索引
    const engine = new FullTextEngine();
    engine.buildIndex(chunks);

    // 执行搜索
    const hits = engine.search(query, options.maxResults * 2);

    // 转换为搜索结果
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
 * 语义搜索
 */
async function semanticSearch(
    query: string,
    chunks: Chunk[],
    config: Config,
    options: SearchOptions
): Promise<SearchResult[]> {
    if (!config.embedding.enabled) {
        throw new Error(
            'Semantic search requires embeddings to be enabled. ' +
            'Set embedding.enabled=true in config and run "notes-search index" first.'
        );
    }

    // 加载索引
    const indexPath = path.join(config.index_dir, 'index.json');
    if (!fs.existsSync(indexPath)) {
        throw new Error(
            'Semantic index not found. Run "notes-search index" to build it first.'
        );
    }

    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));

    if (!indexData.chunks || indexData.chunks.length === 0) {
        throw new Error('Index is empty. Rebuild with "notes-search index --force".');
    }

    const hasEmbeddings = indexData.chunks.some((c: any) => c.embedding && c.embedding.length > 0);
    if (!hasEmbeddings) {
        throw new Error('Index has no embeddings. Rebuild with embedding enabled.');
    }

    // 获取查询嵌入
    const queryEmbedding = await getQueryEmbedding(query, config);

    // 计算相似度
    const results: Array<{ id: string; score: number; chunk: any }> = [];

    for (const chunk of indexData.chunks) {
        if (!chunk.embedding || chunk.embedding.length === 0) continue;

        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        results.push({
            id: chunk.id || `${chunk.path}#${indexData.chunks.indexOf(chunk)}`,
            score: similarity,
            chunk,
        });
    }

    // 排序
    results.sort((a, b) => b.score - a.score);

    // 语义搜索直接使用余弦相似度，不做 Min-Max 归一化
    // 余弦相似度本身在 [-1, 1] 区间，嵌入模型通常输出 [0.3, 1.0] 区间
    const topResults = results.slice(0, options.maxResults * 2);

    return topResults.map(r => ({
        id: r.id,
        title: r.chunk.title || '',
        path: r.chunk.path || '',
        content: r.chunk.content_preview || '',
        score: r.score,  // 保留原始余弦相似度
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
 * 混合搜索 - 使用 RRF 融合
 */
async function hybridSearch(
    query: string,
    chunks: Chunk[],
    config: Config,
    options: SearchOptions
): Promise<SearchResult[]> {
    // 获取词法结果
    const lexicalResults = await lexicalSearch(query, chunks, config, options);

    // 获取语义结果（如果启用）
    let semanticResults: SearchResult[] = [];
    if (config.embedding.enabled) {
        try {
            semanticResults = await semanticSearch(query, chunks, config, options);
        } catch {
            // 语义搜索失败，继续使用词法结果
        }
    }

    // RRF 融合
    const fused = rrfFusion(
        lexicalResults,
        semanticResults,
        60,
        config.hybrid.lexical_weight,
        config.hybrid.semantic_weight
    );

    // 转换结果
    const results = fused.map(f => ({
        ...f.result,
        score: f.rrfScore,
        explanation: {
            lexicalMatches: f.result.explanation?.lexicalMatches || [],
            baseScore: f.rrfScore,
            finalScore: f.rrfScore,
        },
    }));

    // 归一化 Hybrid 结果，确保分数在 0-1 之间且适配阈值
    const normalized = normalizeScores(results);

    // 更新 explanation 中的 finalScore 为归一化后的分数
    return normalized.map(r => {
        if (r.explanation) {
            return {
                ...r,
                explanation: {
                    ...r.explanation,
                    finalScore: r.score
                }
            };
        }
        return r;
    });
}

/**
 * 获取所有 Markdown 文件
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
 * 获取查询嵌入
 */
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
        case 'openai':
            url = base_url || 'https://api.openai.com/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, input: [query] };
            break;

        case 'jina':
            url = base_url || 'https://api.jina.ai/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, input: [query] };
            break;

        case 'siliconflow':
            url = base_url || 'https://api.siliconflow.cn/v1/embeddings';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, input: [query] };
            break;

        case 'ollama':
            url = base_url || 'http://localhost:11434/api/embeddings';
            const ollamaResponse = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: query }),
            });
            const ollamaData = await ollamaResponse.json() as { embedding: number[] };
            return ollamaData.embedding;

        case 'local':
            // 本地 FastAPI 服务（OpenAI 兼容格式）
            url = base_url || 'http://localhost:8000/v1/embeddings';
            headers = { 'Content-Type': 'application/json' };
            // input_type: 'query' 让服务端自动添加 "query: " 前缀
            body = { model, input: [query], input_type: 'query' };
            break;

        case 'cohere':
            url = base_url || 'https://api.cohere.ai/v1/embed';
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            };
            body = { model, texts: [query], input_type: 'search_query' };
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
        return data.data[0].embedding;
    } else if (provider === 'cohere') {
        return data.embeddings[0];
    }

    return data.embeddings[0];
}

/**
 * 截断内容
 */
function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...';
}
