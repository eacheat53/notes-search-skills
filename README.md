# notes-search-skills

Obsidian/Markdown 笔记搜索工具，支持词法搜索、语义搜索和 Cross-Encoder 重排。

## 架构

```
notes-search-skills/
├── notes-search/           # 搜索 CLI (TypeScript/pnpm)
│   └── scripts/
│       ├── cli.ts           # 入口
│       ├── config.ts        # 配置管理
│       ├── commands/
│       │   ├── search.ts    # 搜索（lexical / semantic / hybrid + rerank）
│       │   └── index.ts     # 索引构建
│       └── core/
│           ├── ChunkManager.ts   # Markdown-aware 分块（面包屑 + 引文保护）
│           ├── FullTextEngine.ts  # FlexSearch 全文搜索（CJK 支持）
│           └── Scoring.ts        # RRF 融合 + 余弦相似度
└── embedding-server/       # 本地模型服务 (Python/uv)
    └── main.py             # FastAPI：/v1/embeddings + /v1/rerank
```

## 搜索管线

```
                     ┌─ FlexSearch 词法召回 ─┐
用户 query ─────────►│                        ├─ RRF 融合 ─► Cross-Encoder 精排 ─► Top-N
                     └─ Embedding 语义召回  ─┘
                       (bi-encoder, 快速)       (rank fusion)  (cross-encoder, 精确)
```

| 阶段 | 模型 | 作用 |
| --- | --- | --- |
| Embedding | `intfloat/multilingual-e5-base` | 将 chunk 和 query 编码为向量，余弦相似度召回 |
| Reranking | `BAAI/bge-reranker-v2-m3` | 将 query+document 一起送入 cross-encoder 精排 |

## 快速开始

### 1. 安装依赖

```powershell
# CLI 依赖
cd notes-search
pnpm install

# 嵌入服务依赖
cd ../embedding-server
uv sync
```

### 2. 启动本地服务

```powershell
cd embedding-server
uv run uvicorn main:app --port 8000
```

首次启动会下载模型（embedding ~1GB + reranker ~1.1GB），缓存在 `~/.cache/huggingface`。

服务端点：

- `POST /v1/embeddings` — 文本嵌入（OpenAI 兼容格式）
- `POST /v1/rerank` — 文档重排

### 3. 构建索引

```powershell
cd notes-search
pnpm exec tsx scripts/cli.ts index --dir "E:\Personal\Obsidian-Vaults\ob-vault"
```

索引存储在 `~/.notes-search/{vault_name}/index.json`，支持增量更新（通过 contentHash 判断变更）。

### 4. 搜索

```powershell
# 混合搜索 + 重排（推荐，需要服务和索引）
pnpm exec tsx scripts/cli.ts search -q "偶然性与必然性" -m hybrid -n 5 --dir "E:\Personal\Obsidian-Vaults\ob-vault"

# 纯词法搜索（不需要任何服务）
pnpm exec tsx scripts/cli.ts search -q "扬弃" -m lexical -n 5 --dir "E:\Personal\Obsidian-Vaults\ob-vault"
```

## Chunk 策略

- **Heading-first 分块**：按 `##` / `###` 标题切割
- **面包屑注入**：每个 chunk 开头注入 `[文件名] > 章 > 节` 层级路径
- **引文保护**：Markdown blockquote（`> ...`）不被拆分
- **默认大小**：3000 字符（中文约 1500 字）+ 200 字符 overlap
- **大段落二次切割**：超出 maxChars 时按 `\n\n` 段落边界切割

## 配置

配置文件：`~/.notes-search/config.json`

```powershell
# 查看配置
pnpm exec tsx scripts/cli.ts config --show

# 修改配置
pnpm exec tsx scripts/cli.ts config --set notes_dir=E:\Personal\Obsidian-Vaults\ob-vault
```

关键配置项：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `chunk_size` | 3000 | chunk 最大字符数 |
| `embedding.provider` | `local` | 嵌入服务提供者 |
| `embedding.base_url` | `http://localhost:8000/v1/embeddings` | 嵌入 API 地址 |
| `rerank.enabled` | `true` | 是否启用 Cross-Encoder 重排 |
| `rerank.base_url` | `http://localhost:8000/v1/rerank` | 重排 API 地址 |
| `rerank.top_n` | `5` | 重排后返回的结果数 |
| `hybrid.lexical_weight` | `1.0` | 混合搜索中词法权重 |
| `hybrid.semantic_weight` | `0.7` | 混合搜索中语义权重 |

## 与 Vault 的关系

Vault 中仅保留 `.agents/skills/notes-search/SKILL.md`（AI agent 调用指南），
实际代码和依赖在本项目目录下，避免 HDD 上 node_modules 的性能问题。

## License

MIT
