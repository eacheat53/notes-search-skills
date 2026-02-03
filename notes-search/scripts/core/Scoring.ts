/**
 * Scoring - 评分与融合模块
 * 
 * 提供评分归一化和 RRF (Reciprocal Rank Fusion) 算法
 * 参考 obsidian-copilot 的评分机制
 */

/**
 * 搜索结果接口（通用）
 */
export interface ScoredResult {
    id: string;
    score: number;
    [key: string]: any;
}

/**
 * RRF 融合结果接口
 */
export interface FusedResult<T extends ScoredResult> {
    result: T;
    rrfScore: number;
    sources: Array<{
        source: 'lexical' | 'semantic';
        rank: number;
        originalScore: number;
    }>;
}

/**
 * Min-Max 归一化
 * 将分数归一化到 [minBound, maxBound] 区间
 * 
 * @param results 结果列表
 * @param minBound 最小边界 (默认 0.02)
 * @param maxBound 最大边界 (默认 0.98)
 * @returns 归一化后的结果
 */
export function normalizeScores<T extends ScoredResult>(
    results: T[],
    minBound: number = 0.02,
    maxBound: number = 0.98
): T[] {
    if (results.length === 0) return [];
    if (results.length === 1) {
        return [{ ...results[0], score: (minBound + maxBound) / 2 }];
    }

    const scores = results.map(r => r.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore;

    if (range === 0) {
        // 所有分数相同
        return results.map(r => ({ ...r, score: (minBound + maxBound) / 2 }));
    }

    return results.map(r => ({
        ...r,
        score: minBound + ((r.score - minScore) / range) * (maxBound - minBound),
    }));
}

/**
 * RRF (Reciprocal Rank Fusion) 融合算法
 * 
 * 将多个排序列表融合为一个，使用公式: 1 / (k + rank)
 * 
 * @param lexicalResults 词法搜索结果
 * @param semanticResults 语义搜索结果
 * @param k RRF 常数 (默认 60)
 * @param lexicalWeight 词法权重 (默认 1.0)
 * @param semanticWeight 语义权重 (默认 0.7)
 * @returns 融合后的结果
 */
export function rrfFusion<T extends ScoredResult>(
    lexicalResults: T[],
    semanticResults: T[],
    k: number = 60,
    lexicalWeight: number = 1.0,
    semanticWeight: number = 0.7
): FusedResult<T>[] {
    const fusedMap = new Map<string, FusedResult<T>>();

    // 处理词法结果
    for (let i = 0; i < lexicalResults.length; i++) {
        const result = lexicalResults[i];
        const rrfScore = lexicalWeight / (k + i);

        fusedMap.set(result.id, {
            result,
            rrfScore,
            sources: [{
                source: 'lexical',
                rank: i,
                originalScore: result.score,
            }],
        });
    }

    // 处理语义结果
    for (let i = 0; i < semanticResults.length; i++) {
        const result = semanticResults[i];
        const rrfScore = semanticWeight / (k + i);

        const existing = fusedMap.get(result.id);
        if (existing) {
            // 合并分数
            existing.rrfScore += rrfScore;
            existing.sources.push({
                source: 'semantic',
                rank: i,
                originalScore: result.score,
            });
        } else {
            fusedMap.set(result.id, {
                result,
                rrfScore,
                sources: [{
                    source: 'semantic',
                    rank: i,
                    originalScore: result.score,
                }],
            });
        }
    }

    // 转换并排序
    const fusedResults = Array.from(fusedMap.values());
    fusedResults.sort((a, b) => b.rrfScore - a.rrfScore);

    return fusedResults;
}

/**
 * 简单加权融合
 * 
 * @param lexicalResults 词法搜索结果
 * @param semanticResults 语义搜索结果
 * @param lexicalWeight 词法权重
 * @param semanticWeight 语义权重
 * @returns 融合后的结果
 */
export function weightedFusion<T extends ScoredResult>(
    lexicalResults: T[],
    semanticResults: T[],
    lexicalWeight: number = 0.5,
    semanticWeight: number = 0.5
): T[] {
    const fusedMap = new Map<string, T & { combinedScore: number }>();

    // 处理词法结果
    for (const result of lexicalResults) {
        fusedMap.set(result.id, {
            ...result,
            combinedScore: result.score * lexicalWeight,
        });
    }

    // 处理语义结果
    for (const result of semanticResults) {
        const existing = fusedMap.get(result.id);
        if (existing) {
            existing.combinedScore += result.score * semanticWeight;
        } else {
            fusedMap.set(result.id, {
                ...result,
                combinedScore: result.score * semanticWeight,
            });
        }
    }

    // 转换并排序
    const results = Array.from(fusedMap.values());
    results.sort((a, b) => b.combinedScore - a.combinedScore);

    // 将 combinedScore 映射回 score
    return results.map(r => ({
        ...r,
        score: r.combinedScore,
    }));
}

/**
 * 计算余弦相似度
 * 
 * @param a 向量 A
 * @param b 向量 B
 * @returns 余弦相似度 (0-1)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
