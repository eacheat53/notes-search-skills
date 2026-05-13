/**
 * ChunkManager - 智能分块管理器
 * 
 * 参考 obsidian-copilot/src/search/v3/chunks.ts 实现
 * 使用 heading-first 算法将笔记分割成可搜索的块
 * 
 * 优化：
 * - 面包屑注入：每个 chunk 携带完整的标题层级路径
 * - 引文保护：blockquote 不会被从中间切断
 * - 默认 chunk 大小降至 3000 字符（中文约 1500 字）
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
    /** 分块内容（包含面包屑前缀） */
    content: string;
    /** 内容哈希（用于缓存验证） */
    contentHash: string;
    /** 笔记标题 */
    title: string;
    /** 章节标题（最近的 heading） */
    heading: string;
    /** 面包屑路径（完整层级，如 "二、超越黑格尔 > 重复"） */
    breadcrumb: string;
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
 * 降至 3000 字符 ≈ 中文 1500 字，更精确的检索粒度
 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
    maxChars: 3000,
    overlap: 200,
};

/**
 * 解析后的标题段落
 */
interface HeadingSection {
    /** 标题级别 (1-6) */
    level: number;
    /** 标题文本 */
    heading: string;
    /** 面包屑路径 */
    breadcrumb: string;
    /** 该标题下的正文内容（不含子标题的部分） */
    content: string;
}

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
     * 使用 heading-first 算法 + 面包屑注入
     */
    private async generateChunksForNote(notePath: string): Promise<Chunk[]> {
        const fullPath = path.join(this.notesDir, notePath);

        try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const stat = fs.statSync(fullPath);
            const { data: frontmatter, content: body } = matter(content);

            const title = path.basename(notePath, '.md');
            const tags = this.extractTags(frontmatter, body);

            // 按标题分割，保留层级信息
            const sections = this.splitByHeadingsWithBreadcrumb(body, title);
            const chunks: Chunk[] = [];

            for (const section of sections) {
                if (!section.content.trim()) continue;

                // 构建面包屑前缀
                const breadcrumbPrefix = section.breadcrumb
                    ? `[${title}] > ${section.breadcrumb}\n\n`
                    : `[${title}]\n\n`;

                const contentWithBreadcrumb = breadcrumbPrefix + section.content.trim();

                // 如果章节超过最大大小，进一步分割
                if (contentWithBreadcrumb.length > this.options.maxChars) {
                    const subChunks = this.splitLargeSection(
                        section.content.trim(),
                        breadcrumbPrefix,
                        section.heading,
                        section.breadcrumb,
                        notePath,
                        title,
                        tags,
                        stat.mtimeMs,
                        chunks.length
                    );
                    chunks.push(...subChunks);
                } else {
                    chunks.push({
                        id: this.generateChunkId(notePath, chunks.length),
                        notePath,
                        chunkIndex: chunks.length,
                        content: contentWithBreadcrumb,
                        contentHash: this.calculateHash(section.content),
                        title,
                        heading: section.heading || '',
                        breadcrumb: section.breadcrumb,
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
     * 按标题分割内容，保留层级面包屑
     * 
     * 例如：
     *   ## 四、必然性
     *   ### 克尔凯郭尔的批判
     *   正文...
     * 
     * 会生成 breadcrumb: "四、必然性 > 克尔凯郭尔的批判"
     */
    private splitByHeadingsWithBreadcrumb(content: string, title: string): HeadingSection[] {
        const sections: HeadingSection[] = [];
        const lines = content.split('\n');

        // 维护当前各级标题的栈
        const headingStack: Array<{ level: number; text: string }> = [];
        let currentHeading = '';
        let currentLevel = 0;
        let currentContent: string[] = [];

        const flushSection = () => {
            if (currentContent.length > 0) {
                const breadcrumb = headingStack.map(h => h.text).join(' > ');
                sections.push({
                    level: currentLevel,
                    heading: currentHeading,
                    breadcrumb,
                    content: currentContent.join('\n'),
                });
            }
        };

        for (const line of lines) {
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

            if (headingMatch) {
                // 保存上一个章节
                flushSection();

                const level = headingMatch[1].length;
                const text = headingMatch[2].trim();

                // 更新标题栈：弹出所有 >= 当前级别的标题
                while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
                    headingStack.pop();
                }
                headingStack.push({ level, text });

                currentHeading = text;
                currentLevel = level;
                currentContent = [];
            } else {
                currentContent.push(line);
            }
        }

        // 保存最后一个章节
        flushSection();

        return sections;
    }

    /**
     * 分割大型章节
     * 按段落分割，保持语义完整性
     * 
     * 优化：
     * - 引文块（> 开头的连续行）不会被拆分
     * - 支持 overlap 重叠
     */
    private splitLargeSection(
        content: string,
        breadcrumbPrefix: string,
        heading: string,
        breadcrumb: string,
        notePath: string,
        title: string,
        tags: string[],
        mtime: number,
        startIndex: number
    ): Chunk[] {
        const chunks: Chunk[] = [];
        const blocks = this.splitIntoBlocks(content);
        const prefixLen = breadcrumbPrefix.length;

        let currentBlocks: string[] = [];
        let currentSize = prefixLen; // 预留面包屑空间

        for (const block of blocks) {
            if (currentSize + block.length > this.options.maxChars && currentBlocks.length > 0) {
                // 保存当前分块
                const chunkBody = currentBlocks.join('\n\n').trim();
                if (chunkBody) {
                    chunks.push({
                        id: this.generateChunkId(notePath, startIndex + chunks.length),
                        notePath,
                        chunkIndex: startIndex + chunks.length,
                        content: breadcrumbPrefix + chunkBody,
                        contentHash: this.calculateHash(chunkBody),
                        title,
                        heading: heading || '',
                        breadcrumb,
                        tags,
                        mtime,
                    });
                }

                // 实现 overlap：保留最后一个 block 作为下一个 chunk 的开头
                if (this.options.overlap > 0 && currentBlocks.length > 0) {
                    const lastBlock = currentBlocks[currentBlocks.length - 1];
                    if (lastBlock.length <= this.options.overlap) {
                        currentBlocks = [lastBlock];
                        currentSize = prefixLen + lastBlock.length;
                    } else {
                        currentBlocks = [];
                        currentSize = prefixLen;
                    }
                } else {
                    currentBlocks = [];
                    currentSize = prefixLen;
                }
            }

            currentBlocks.push(block);
            currentSize += block.length + 2; // +2 for \n\n separator
        }

        // 保存剩余内容
        if (currentBlocks.length > 0) {
            const chunkBody = currentBlocks.join('\n\n').trim();
            if (chunkBody) {
                chunks.push({
                    id: this.generateChunkId(notePath, startIndex + chunks.length),
                    notePath,
                    chunkIndex: startIndex + chunks.length,
                    content: breadcrumbPrefix + chunkBody,
                    contentHash: this.calculateHash(chunkBody),
                    title,
                    heading: heading || '',
                    breadcrumb,
                    tags,
                    mtime,
                });
            }
        }

        return chunks;
    }

    /**
     * 将内容分割成「块」，引文块作为整体保留
     * 
     * 普通段落按 \n\n 分割；
     * 连续的 > 行（blockquote）合并为一个不可拆分的块
     */
    private splitIntoBlocks(content: string): string[] {
        const blocks: string[] = [];
        const lines = content.split('\n');

        let currentBlock: string[] = [];
        let inBlockquote = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const isQuoteLine = line.startsWith('>') || (inBlockquote && line.trim() === '');
            const isEmptyLine = line.trim() === '';

            if (isQuoteLine) {
                // 如果之前在积累普通文本，先保存
                if (!inBlockquote && currentBlock.length > 0) {
                    const text = currentBlock.join('\n').trim();
                    if (text) blocks.push(text);
                    currentBlock = [];
                }
                inBlockquote = true;
                currentBlock.push(line);
            } else if (inBlockquote) {
                // 引文块结束
                if (currentBlock.length > 0) {
                    const text = currentBlock.join('\n').trim();
                    if (text) blocks.push(text);
                    currentBlock = [];
                }
                inBlockquote = false;

                if (!isEmptyLine) {
                    currentBlock.push(line);
                }
            } else if (isEmptyLine) {
                // 普通段落边界
                if (currentBlock.length > 0) {
                    const text = currentBlock.join('\n').trim();
                    if (text) blocks.push(text);
                    currentBlock = [];
                }
            } else {
                currentBlock.push(line);
            }
        }

        // 保存最后一个块
        if (currentBlock.length > 0) {
            const text = currentBlock.join('\n').trim();
            if (text) blocks.push(text);
        }

        return blocks;
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
            bytes += chunk.breadcrumb.length * 2;
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
