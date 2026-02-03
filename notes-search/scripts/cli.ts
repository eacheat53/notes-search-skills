#!/usr/bin/env node
/**
 * Notes Search CLI
 * 
 * A command-line tool for searching Markdown notes with lexical and semantic search.
 * Ported from obsidian-copilot's search implementation.
 */

import { Command } from 'commander';
import { searchNotes } from './commands/search.js';
import { buildIndex } from './commands/index.js';
import { manageConfig } from './commands/config.js';

const program = new Command();

program
    .name('notes-search')
    .description('Search your Markdown notes with lexical and semantic search')
    .version('1.0.0');

// Search command
program
    .command('search')
    .description('Search notes for relevant content')
    .requiredOption('-q, --query <string>', 'Search query')
    .option('-m, --mode <mode>', 'Search mode: lexical, semantic, or hybrid', 'lexical')
    .option('-n, --max-results <number>', 'Maximum number of results', '5')
    .option('-t, --threshold <number>', 'Minimum similarity score (0-1)', '0.1')
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .option('--dir <path>', 'Notes directory (overrides config)')
    .option('--explain', 'Include match explanation in results')
    .option('--chunk-size <number>', 'Chunk size in characters (default: 6000)')
    .action(async (options) => {
        try {
            const result = await searchNotes({
                query: options.query,
                mode: options.mode as 'lexical' | 'semantic' | 'hybrid',
                maxResults: parseInt(options.maxResults),
                threshold: parseFloat(options.threshold),
                tags: options.tags ? options.tags.split(',').map((t: string) => t.trim()) : undefined,
                notesDir: options.dir,
                explain: options.explain,
                chunkSize: options.chunkSize ? parseInt(options.chunkSize) : undefined,
            });
            console.log(JSON.stringify(result, null, 2));
        } catch (error) {
            console.error(JSON.stringify({ error: (error as Error).message }));
            process.exit(1);
        }
    });

// Index command
program
    .command('index')
    .description('Build search index for semantic search')
    .option('--dir <path>', 'Notes directory')
    .option('--force', 'Force full rebuild')
    .action(async (options) => {
        try {
            const result = await buildIndex({
                notesDir: options.dir,
                force: options.force,
            });
            console.log(JSON.stringify(result, null, 2));
        } catch (error) {
            console.error(JSON.stringify({ error: (error as Error).message }));
            process.exit(1);
        }
    });

// Config command
program
    .command('config')
    .description('Manage configuration')
    .option('--show', 'Show current configuration')
    .option('--set <key=value>', 'Set a configuration value')
    .option('--init', 'Initialize configuration with defaults')
    .action(async (options) => {
        try {
            const result = await manageConfig({
                show: options.show,
                set: options.set,
                init: options.init,
            });
            console.log(JSON.stringify(result, null, 2));
        } catch (error) {
            console.error(JSON.stringify({ error: (error as Error).message }));
            process.exit(1);
        }
    });

program.parse();
