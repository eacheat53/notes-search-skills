/**
 * Core 模块导出
 */

export { ChunkManager, type Chunk, type ChunkOptions, DEFAULT_CHUNK_OPTIONS } from './ChunkManager.js';
export { FullTextEngine, type SearchHit, type MatchExplanation, type FieldWeights, DEFAULT_FIELD_WEIGHTS } from './FullTextEngine.js';
export { normalizeScores, rrfFusion, weightedFusion, cosineSimilarity, type ScoredResult, type FusedResult } from './Scoring.js';
