/**
 * Configuration management for notes-search
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface EmbeddingConfig {
    enabled: boolean;
    provider: 'openai' | 'cohere' | 'ollama' | 'siliconflow' | 'jina' | 'local';
    model: string;
    api_key_env: string;
    base_url?: string;
    batch_size: number;
}

export interface HybridConfig {
    lexical_weight: number;
    semantic_weight: number;
    tag_boost: number;
}

export interface Config {
    notes_dir: string;
    max_results: number;
    min_score: number;
    default_mode: 'lexical' | 'semantic' | 'hybrid';
    chunk_size: number;
    inclusions: string[];
    exclusions: string[];
    embedding: EmbeddingConfig;
    index_dir: string;
    auto_update: boolean;
    hybrid: HybridConfig;
}

const DEFAULT_CONFIG: Config = {
    notes_dir: '',
    max_results: 5,
    min_score: 0.1,
    default_mode: 'hybrid',
    chunk_size: 4000,
    inclusions: ['**/*.md'],
    exclusions: [
        '**/node_modules/**',
        '**/.obsidian/**',
        '**/.git/**',
        '**/templates/**',
        '**/.agent/**',
    ],
    embedding: {
        enabled: true,
        provider: 'local',
        model: 'multilingual-e5-base',
        api_key_env: '',  // local 不需要 API key
        batch_size: 50,  // 本地服务用较小 batch
        base_url: 'http://localhost:8000/v1/embeddings',
    },
    index_dir: '',  // 动态计算
    auto_update: false,
    hybrid: {
        lexical_weight: 1.0,
        semantic_weight: 0.7,
        tag_boost: 1.2,
    },
};

/**
 * 根据 notes_dir 获取 vault 名称
 */
function getVaultName(notesDir: string): string {
    if (!notesDir) return 'default';
    return path.basename(notesDir);
}

/**
 * 获取索引目录：~/.notes-search/{vault_name}/
 */
function getIndexDir(notesDir: string): string {
    const vaultName = getVaultName(notesDir);
    return path.join(os.homedir(), '.notes-search', vaultName);
}

function getConfigPath(): string {
    const envPath = process.env.NOTES_SEARCH_CONFIG;
    if (envPath) return envPath;
    return path.join(os.homedir(), '.notes-search', 'config.json');
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
    const result = { ...target };

    for (const key in source) {
        if (source[key] !== undefined) {
            if (
                typeof source[key] === 'object' &&
                source[key] !== null &&
                !Array.isArray(source[key]) &&
                typeof (target as any)[key] === 'object'
            ) {
                (result as any)[key] = deepMerge((target as any)[key], source[key] as any);
            } else {
                (result as any)[key] = source[key];
            }
        }
    }

    return result;
}

export function loadConfig(): Config {
    const configPath = getConfigPath();

    let config: Config;

    if (!fs.existsSync(configPath)) {
        const envNotesDir = process.env.NOTES_DIR;
        if (envNotesDir) {
            config = { ...DEFAULT_CONFIG, notes_dir: envNotesDir };
        } else {
            config = { ...DEFAULT_CONFIG };
        }
    } else {
        try {
            const content = fs.readFileSync(configPath, 'utf-8');
            const userConfig = JSON.parse(content);
            config = deepMerge(DEFAULT_CONFIG, userConfig);
        } catch (error) {
            console.error(`Warning: Failed to load config from ${configPath}`, error);
            config = { ...DEFAULT_CONFIG };
        }
    }

    // 动态设置 index_dir（按 vault 隔离）
    if (!config.index_dir && config.notes_dir) {
        config.index_dir = getIndexDir(config.notes_dir);
    } else if (!config.index_dir) {
        config.index_dir = path.join(os.homedir(), '.notes-search', 'default');
    }

    return config;
}

export function saveConfig(config: Partial<Config>): void {
    const configPath = getConfigPath();
    const configDir = path.dirname(configPath);

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const existingConfig = loadConfig();
    const newConfig = deepMerge(existingConfig, config);

    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
}

export function setConfigValue(keyPath: string, value: string): void {
    const config = loadConfig();
    const keys = keyPath.split('.');

    let current: any = config;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in current)) {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }

    const lastKey = keys[keys.length - 1];

    if (value === 'true') {
        current[lastKey] = true;
    } else if (value === 'false') {
        current[lastKey] = false;
    } else if (!isNaN(Number(value))) {
        current[lastKey] = Number(value);
    } else {
        current[lastKey] = value;
    }

    saveConfig(config);
}

export function validateConfig(config: Config, options?: { requireEmbedding?: boolean }): string[] {
    const errors: string[] = [];

    if (!config.notes_dir) {
        errors.push('notes_dir is required. Set it with: notes-search config --set notes_dir=/path/to/notes');
    } else if (!fs.existsSync(config.notes_dir)) {
        errors.push(`notes_dir does not exist: ${config.notes_dir}`);
    }

    if (options?.requireEmbedding && config.embedding.enabled) {
        const apiKey = process.env[config.embedding.api_key_env];
        if (!apiKey && config.embedding.provider !== 'ollama' && config.embedding.provider !== 'local') {
            errors.push(`Embedding API key not found. Set ${config.embedding.api_key_env} environment variable.`);
        }
    }

    return errors;
}
