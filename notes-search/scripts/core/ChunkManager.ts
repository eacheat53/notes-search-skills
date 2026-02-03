/**
 * ChunkManager - 智能分块管理器
 * 
 * 参考 obsidian-copilot/src/search/v3/chunks.ts 实现
 * 使用 heading-first 算法将笔记分割成可搜索的块
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import matter from 'gray-matter';

/**
 * 分块接口
 */
export interface Chunk {
    /** 唯一标识符，格式: "note_path#chunk_index" */
    id: string;
    /** 原始笔记路径 */
    notePath: string;
    /** 分块索引 (0-based) */
    chunkIndex: number;
    /** 分块内容 */
    content: string;
    /** 内容哈希（用于缓存验证） */
    contentHash: string;
    /** 笔记标题 */
    title: string;
    /** 章节标题 */
    heading: string;
    /** 标签列表 */
    tags: string[];
    /** 文件修改时间 */
    mtime: number;
}

/**
 * 分块选项
 */
export interface ChunkOptions {
    /** 每个分块的最大字符数 */
    maxChars: number;
    /** 分块重叠字符数 */
    overlap: number;
}

/**
 * 默认分块选项
 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
    maxChars: 6000,
    overlap: 0,
};

/**
 * ChunkManager - 分块管理器
 * 
 * 使用 heading-first 算法将笔记分割成语义完整的块
 */
export class ChunkManager {
    private cache: Map<string, Chunk[]> = new Map();
    private memoryUsage: number = 0;
    private options: ChunkOptions;

    constructor(
        private notesDir: string,
        options: Partial<ChunkOptions> = {}
    ) {
        this.options = { ...DEFAULT_CHUNK_OPTIONS, ...options };
    }

    /**
     * 获取多个笔记的分块
     * @param notePaths 笔记路径列表（相对路径）
     * @returns 所有分块
     */
    async getChunks(notePaths: string[]): Promise<Chunk[]> {
        const allChunks: Chunk[] = [];

        for (const notePath of notePaths) {
            // 检查缓存
            if (this.cache.has(notePath)) {
                const cached = this.cache.get(notePath)!;
                // 验证缓存是否过期
                const fullPath = path.join(this.notesDir, notePath);
                try {
                    const stat = fs.statSync(fullPath);
                    if (cached.length > 0 && cached[0].mtime === stat.mtimeMs) {
                        allChunks.push(...cached);
                        continue;
                    }
                } catch {
                    // 文件不存在，清除缓存
                    this.cache.delete(notePath);
                    continue;
                }
            }

            // 生成新分块
            const chunks = await this.generateChunksForNote(notePath);
            if (chunks.length > 0) {
                this.cache.set(notePath, chunks);
                this.memoryUsage += this.calculateChunkBytes(chunks);
                allChunks.push(...chunks);
            }
        }

        return allChunks;
    }

    /**
     * 通过 ID 获取分块内容
     * @param id 分块 ID（格式: "note_path#chunk_index"）
     * @returns 分块内容，如果不存在则返回空字符串
     */
    async getChunkText(id: string): Promise<string> {
        const chunk = await this.ensureChunkExists(id);
        return chunk?.content || '';
    }

    /**
     * 确保分块存在于缓存中
     */
    private async ensureChunkExists(id: string): Promise<Chunk | null> {
        const [notePath, indexStr] = id.split('#');
        const chunkIndex = parseInt(indexStr, 10);

        if (isNaN(chunkIndex)) return null;

        // 确保笔记已分块
        await this.getChunks([notePath]);

        const chunks = this.cache.get(notePath);
        return chunks?.find(c => c.chunkIndex === chunkIndex) || null;
    }

    /**
     * 为单个笔记生成分块
     * 使用 heading-first 算法
     */
    private async generateChunksForNote(notePath: string): Promise<Chunk[]> {
        const fullPath = path.join(this.notesDir, notePath);

        try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const stat = fs.statSync(fullPath);
            const { data: frontmatter, content: body } = matter(content);

            const title = path.basename(notePath, '.md');
            const tags = this.extractTags(frontmatter, body);

            // 按标题分割
            const sections = this.splitByHeadings(body);
            const chunks: Chunk[] = [];

            for (let i = 0; i < sections.length; i++) {
                const section = sections[i];

                // 如果章节超过最大大小，进一步分割
                if (section.content.length > this.options.maxChars) {
                    const subChunks = this.splitLargeSection(
                        section.content,
                        section.heading,
                        notePath,
                        title,
                        tags,
                        stat.mtimeMs,
                        chunks.length
                    );
                    chunks.push(...subChunks);
                } else if (section.content.trim()) {
                    chunks.push({
                        id: this.generateChunkId(notePath, chunks.length),
                        notePath,
                        chunkIndex: chunks.length,
                        content: section.content.trim(),
                        contentHash: this.calculateHash(section.content),
                        title,
                        heading: section.heading || '',
                        tags,
                        mtime: stat.mtimeMs,
                    });
                }
            }

            return chunks;
        } catch (error) {
            // 文件读取失败，返回空数组
            return [];
        }
    }

    /**
     * 按标题分割内容
     */
    private splitByHeadings(content: string): Array<{ heading?: string; content: string }> {
        const sections: Array<{ heading?: string; content: string }> = [];
        const lines = content.split('\n');

        let currentHeading: string | undefined;
        let currentContent: string[] = [];

        for (const line of lines) {
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

            if (headingMatch) {
                // 保存上一个章节
                if (currentContent.length > 0) {
                    sections.push({
                        heading: currentHeading,
                        content: currentContent.join('\n'),
                    });
                }

                currentHeading = headingMatch[2];
                currentContent = [];
            } else {
                currentContent.push(line);
            }
        }

        // 保存最后一个章节
        if (currentContent.length > 0) {
            sections.push({
                heading: currentHeading,
                content: currentContent.join('\n'),
            });
        }

        return sections;
    }

    /**
     * 分割大型章节
     * 按段落分割，保持语义完整性
     */
    private splitLargeSection(
        content: string,
        heading: string | undefined,
        notePath: string,
        title: string,
        tags: string[],
        mtime: number,
        startIndex: number
    ): Chunk[] {
        const chunks: Chunk[] = [];
        const paragraphs = content.split(/\n\n+/);

        let currentChunk: string[] = [];
        let currentSize = 0;

        for (const para of paragraphs) {
            if (currentSize + para.length > this.options.maxChars && currentChunk.length > 0) {
                // 保存当前分块
                const chunkContent = currentChunk.join('\n\n').trim();
                if (chunkContent) {
                    chunks.push({
                        id: this.generateChunkId(notePath, startIndex + chunks.length),
                        notePath,
                        chunkIndex: startIndex + chunks.length,
                        content: chunkContent,
                        contentHash: this.calculateHash(chunkContent),
                        title,
                        heading: heading || '',
                        tags,
                        mtime,
                    });
                }
                currentChunk = [];
                currentSize = 0;
            }

            currentChunk.push(para);
            currentSize += para.length;
        }

        // 保存剩余内容
        if (currentChunk.length > 0) {
            const chunkContent = currentChunk.join('\n\n').trim();
            if (chunkContent) {
                chunks.push({
                    id: this.generateChunkId(notePath, startIndex + chunks.length),
                    notePath,
                    chunkIndex: startIndex + chunks.length,
                    content: chunkContent,
                    contentHash: this.calculateHash(chunkContent),
                    title,
                    heading: heading || '',
                    tags,
                    mtime,
                });
            }
        }

        return chunks;
    }

    /**
     * 提取标签
     */
    private extractTags(frontmatter: any, content: string): string[] {
        const tags = new Set<string>();

        // 从 frontmatter 提取
        if (frontmatter.tags) {
            const fmTags = Array.isArray(frontmatter.tags)
                ? frontmatter.tags
                : [frontmatter.tags];
            for (const tag of fmTags) {
                tags.add(tag.startsWith('#') ? tag : `#${tag}`);
            }
        }

        // 从内容提取内联标签
        const inlineTags = content.match(/#[\w\u4e00-\u9fff/-]+/g) || [];
        for (const tag of inlineTags) {
            tags.add(tag);
        }

        return Array.from(tags);
    }

    /**
     * 生成分块 ID
     */
    private generateChunkId(notePath: string, chunkIndex: number): string {
        return `${notePath}#${chunkIndex}`;
    }

    /**
     * 计算内容哈希
     */
    private calculateHash(content: string): string {
        return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    }

    /**
     * 计算分块占用的字节数
     */
    private calculateChunkBytes(chunks: Chunk[]): number {
        let bytes = 0;
        for (const chunk of chunks) {
            bytes += chunk.content.length * 2; // UTF-16 估算
            bytes += chunk.id.length * 2;
            bytes += chunk.title.length * 2;
            bytes += chunk.heading.length * 2;
        }
        return bytes;
    }

    /**
     * 清除缓存
     */
    clearCache(): void {
        this.cache.clear();
        this.memoryUsage = 0;
    }

    /**
     * 获取缓存统计
     */
    getCacheStats(): { noteCount: number; chunkCount: number; memoryUsage: number } {
        let chunkCount = 0;
        for (const chunks of this.cache.values()) {
            chunkCount += chunks.length;
        }
        return {
            noteCount: this.cache.size,
            chunkCount,
            memoryUsage: this.memoryUsage,
        };
    }
}
