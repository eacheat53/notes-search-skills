/**
 * FullTextEngine - 全文搜索引擎
 * 
 * 封装 FlexSearch，提供多字段权重搜索能力
 * 参考 obsidian-copilot/src/search/v3 实现
 */

import FlexSearch from 'flexsearch';
import type { Chunk } from './ChunkManager.js';

/**
 * 搜索结果接口
 */
export interface SearchHit {
    /** 分块 ID */
    id: string;
    /** 相关性分数 (0-1) */
    score: number;
    /** 匹配解释 */
    explanation: MatchExplanation;
}

/**
 * 匹配解释接口
 */
export interface MatchExplanation {
    /** 词法匹配详情 */
    lexicalMatches: Array<{
        field: string;
        term: string;
        weight: number;
    }>;
    /** 原始分数（归一化前） */
    baseScore: number;
    /** 最终分数（归一化后） */
    finalScore: number;
}

/**
 * 字段权重配置
 */
export interface FieldWeights {
    title: number;
    heading: number;
    path: number;
    tags: number;
    body: number;
}

/**
 * 默认字段权重
 * 参考 obsidian-copilot: Title (3x), Heading (2.5x), Path (2x), Tags (4x), Body (1x)
 */
export const DEFAULT_FIELD_WEIGHTS: FieldWeights = {
    title: 3.0,
    heading: 2.5,
    path: 2.0,
    tags: 4.0,
    body: 1.0,
};

/**
 * 索引文档结构
 */
interface IndexDocument {
    id: string;
    title: string;
    heading: string;
    path: string;
    tags: string;
    body: string;
}

/**
 * FullTextEngine - 全文搜索引擎
 */
export class FullTextEngine {
    private index: FlexSearch.Document<IndexDocument, string[]>;
    private documents: Map<string, IndexDocument> = new Map();
    private fieldWeights: FieldWeights;

    constructor(weights: Partial<FieldWeights> = {}) {
        this.fieldWeights = { ...DEFAULT_FIELD_WEIGHTS, ...weights };

        // 创建 FlexSearch 文档索引
        this.index = new FlexSearch.Document<IndexDocument, string[]>({
            document: {
                id: 'id',
                index: ['title', 'heading', 'path', 'tags', 'body'],
                store: ['title', 'heading', 'path', 'tags', 'body'],
            },
            tokenize: 'forward',
            context: true,
            // CJK 支持
            encode: (str: string) => {
                // ASCII 词 + CJK 字符分词
                const asciiWords = str.toLowerCase().match(/[a-z0-9]+/g) || [];
                const cjkChars = str.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
                return [...asciiWords, ...cjkChars];
            },
        });
    }

    /**
     * 从分块构建索引
     * @param chunks 分块列表
     */
    buildIndex(chunks: Chunk[]): void {
        // 清除旧索引
        this.documents.clear();

        for (const chunk of chunks) {
            const doc: IndexDocument = {
                id: chunk.id,
                title: chunk.title,
                heading: chunk.heading,
                path: chunk.notePath,
                tags: chunk.tags.join(' '),
                body: chunk.content,
            };

            this.documents.set(chunk.id, doc);
            this.index.add(doc);
        }
    }

    /**
     * 执行搜索
     * @param query 查询字符串
     * @param limit 最大返回数量
     * @returns 搜索结果
     */
    search(query: string, limit: number = 50): SearchHit[] {
        // 在各字段中搜索
        const searchResults = this.index.search(query, {
            limit: limit * 2,
            enrich: true,
        });

        // 计算加权分数
        const scoreMap = new Map<string, { score: number; matches: MatchExplanation['lexicalMatches'] }>();
        const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

        for (const fieldResult of searchResults) {
            const field = fieldResult.field as keyof FieldWeights;
            const weight = this.fieldWeights[field] || 1.0;

            for (const hit of fieldResult.result) {
                const id = typeof hit === 'object' && 'id' in hit ? String(hit.id) : String(hit);
                const existing = scoreMap.get(id) || { score: 0, matches: [] };

                // 累加字段权重分数
                existing.score += weight;

                // 记录匹配详情
                for (const term of queryTerms) {
                    existing.matches.push({
                        field,
                        term,
                        weight,
                    });
                }

                scoreMap.set(id, existing);
            }
        }

        // 转换为结果数组
        const results: Array<{ id: string; score: number; matches: MatchExplanation['lexicalMatches'] }> = [];
        for (const [id, data] of scoreMap) {
            results.push({ id, score: data.score, matches: data.matches });
        }

        // 按分数排序
        results.sort((a, b) => b.score - a.score);

        // 归一化分数
        return this.normalizeScores(results.slice(0, limit));
    }

    /**
     * Min-Max 归一化分数
     */
    private normalizeScores(
        results: Array<{ id: string; score: number; matches: MatchExplanation['lexicalMatches'] }>
    ): SearchHit[] {
        if (results.length === 0) return [];

        const scores = results.map(r => r.score);
        const minScore = Math.min(...scores);
        const maxScore = Math.max(...scores);
        const range = maxScore - minScore;

        return results.map(r => {
            // Min-Max 归一化到 [0.02, 0.98] 区间
            const normalized = range > 0
                ? 0.02 + (r.score - minScore) / range * 0.96
                : 0.5;

            return {
                id: r.id,
                score: normalized,
                explanation: {
                    lexicalMatches: r.matches,
                    baseScore: r.score,
                    finalScore: normalized,
                },
            };
        });
    }

    /**
     * 获取文档内容
     */
    getDocument(id: string): IndexDocument | undefined {
        return this.documents.get(id);
    }

    /**
     * 清除索引
     */
    clear(): void {
        this.documents.clear();
        // 重新创建索引
        this.index = new FlexSearch.Document<IndexDocument, string[]>({
            document: {
                id: 'id',
                index: ['title', 'heading', 'path', 'tags', 'body'],
                store: ['title', 'heading', 'path', 'tags', 'body'],
            },
            tokenize: 'forward',
            context: true,
            encode: (str: string) => {
                const asciiWords = str.toLowerCase().match(/[a-z0-9]+/g) || [];
                const cjkChars = str.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || [];
                return [...asciiWords, ...cjkChars];
            },
        });
    }

    /**
     * 获取索引统计
     */
    getStats(): { documentCount: number } {
        return {
            documentCount: this.documents.size,
        };
    }
}
