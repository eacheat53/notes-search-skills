# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Two-component personal Markdown note search system: a TypeScript CLI (`notes-search/`) and a Python embedding/reranking server (`embedding-server/`). The CLI indexes Obsidian vaults into SQLite, then retrieves results via lexical (FlexSearch), semantic (bi-encoder cosine similarity), or hybrid (RRF fusion + cross-encoder rerank) modes.

## Build & run

Use `pnpm` for the TypeScript package and `uv` for the Python server.

```bash
# Install CLI dependencies
cd notes-search && pnpm install

# Install server dependencies
cd embedding-server && uv sync

# Run CLI commands (uses tsx directly — tsconfig points to src/ but sources live in scripts/)
cd notes-search && pnpm exec tsx scripts/cli.ts search -q "query" -m hybrid -n 5 --dir "/path/to/vault"
cd notes-search && pnpm exec tsx scripts/cli.ts index --dir "/path/to/vault"

# Start the embedding/rerank server (loads ~2.1GB of models on first run)
cd embedding-server && uv run uvicorn main:app --port 8000
```

`tsc` build (`pnpm build`) will fail because `tsconfig.json` sets `rootDir: "./src"` and `include: ["src/**/*"]`, but all source `.ts` files are under `scripts/`, not `src/`. The `package.json` dev/build scripts still reference `src/` paths as well. The project is run exclusively via `tsx` against the `scripts/` directory — this mismatch needs resolution if you want compiled output.

## Architecture

```
query → [FlexSearch lexical] + [bi-encoder semantic] → RRF fusion → cross-encoder rerank → top-N
```

**`notes-search/scripts/cli.ts`** — Commander entry point with three subcommands: `search`, `index`, `config`. All output JSON.

**`notes-search/scripts/config.ts`** — `Config` interface and defaults. Config lives at `~/.notes-search/config.json` (overridable via `NOTES_SEARCH_CONFIG` env var). Indexes are per-vault at `~/.notes-search/{vault_name}/index.db`. Supports `deepMerge` for partial updates and dot-path key setting.

**`notes-search/scripts/commands/index.ts`** — Reads Markdown files via glob, chunks them through `ChunkManager`, batches embedding API calls (6 providers supported: openai/ollama/local/cohere/siliconflow/jina), stores everything in SQLite. Incremental: skips unchanged chunks by content hash.

**`notes-search/scripts/commands/search.ts`** — Loads chunks from SQLite (or disk if no index). Lexical mode builds an in-memory FlexSearch index. Semantic mode computes cosine similarity against all chunk embeddings. Hybrid mode fuses both with RRF and optionally calls the rerank endpoint. Also handles the query embedding call (with `input_type: "query"` vs `"passage"` for indexing).

**`notes-search/scripts/core/ChunkManager.ts`** — Markdown-aware chunking: splits by headings, maintains breadcrumb stacks, protects blockquotes from being split, splits oversized sections by paragraph boundaries. Default 3000 chars + 200 overlap. Caches by mtime.

**`notes-search/scripts/core/FullTextEngine.ts`** — FlexSearch document index across 5 fields (title×3, heading×2.5, path×2, tags×4, body×1). Custom CJK tokenizer splits each CJK character as a separate token.

**`notes-search/scripts/core/IndexStore.ts`** — better-sqlite3 with WAL mode and 64MB cache. Schema: `meta` (key-value) and `chunks` (id, title, path, heading, breadcrumb, tags as JSON, content, content_hash, embedding as Float32Array BLOB). Embeddings are stored as binary Float32Array buffers, not JSON.

**`notes-search/scripts/core/Scoring.ts`** — Min-max normalization, RRF fusion (k=60, configurable lexical/semantic weights), weighted fusion, cosine similarity.

**`embedding-server/main.py`** — FastAPI server with lifespan-managed model loading. Two HuggingFace models: `intfloat/multilingual-e5-base` (384-dim embeddings) and `BAAI/bge-reranker-v2-m3` (cross-encoder). Endpoints: `GET /` (health), `GET /v1/models`, `POST /v1/embeddings` (OpenAI-compatible, auto-prefixes `query: ` / `passage: ` for E5), `POST /v1/rerank` (query-document pair scoring).

## SKILL.md

`notes-search/SKILL.md` is the AI agent integration manifest — it tells agent hosts when to invoke this tool and how to execute it. The `notes-search` package is deployed as a skill inside vaults via `.agents/skills/notes-search/`.
