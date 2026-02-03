# notes-search-skills

Obsidian/Markdown 笔记语义搜索工具，包含搜索 CLI 和本地嵌入服务。

## 目录结构

```
notes-search-skills/
├── notes-search/           # 搜索 CLI (TypeScript)
└── embedding-server/       # 本地嵌入服务 (Python)
```

## 安装步骤

### 1. 复制到 Vault

将 `notes-search/` 文件夹复制到你的 Obsidian Vault 的 `.agent/skills/` 目录下：

```powershell
# 示例
Copy-Item -Recurse notes-search /path/to/your/vault/.agent/skills/
```

最终结构应为：

```
your-vault/
└── .agent/
    └── skills/
        └── notes-search/
            ├── SKILL.md
            └── scripts/
```

### 2. 安装依赖

```powershell
# CLI 依赖
cd /path/to/your/vault/.agent/skills/notes-search/scripts
pnpm install

# 嵌入服务依赖
cd /path/to/embedding-server
uv sync
```

### 3. 配置笔记目录

```bash
cd /path/to/your/vault/.agent/skills/notes-search/scripts
npx tsx src/cli.ts config --set notes_dir=/path/to/your/vault
```

### 4. 配置嵌入服务

默认配置已设为使用本地嵌入服务。查看配置：

```bash
npx tsx src/cli.ts config --show
```

确保以下配置正确：

- `embedding.enabled`: `true`
- `embedding.provider`: `local`
- `embedding.base_url`: `http://localhost:8000/v1/embeddings`

### 5. 修改 SKILL.md

> ⚠️ **重要**：打开 `.agent/skills/notes-search/SKILL.md`，修改启动本地嵌入服务的命令路径：

```powershell
# 将这行改为你的 embedding-server 实际路径
cd /your/path/to/embedding-server; uv run uvicorn main:app --port 8000
```

### 6. 启动嵌入服务并构建索引

```powershell
# 启动嵌入服务
cd /path/to/embedding-server
uv run uvicorn main:app --port 8000

# 在另一个终端构建索引
cd /path/to/your/vault/.agent/skills/notes-search/scripts
npx tsx src/cli.ts index
```

首次运行会下载模型（约 1GB），之后缓存在 `~/.cache/huggingface`。

## 使用

配置完成后，Agent 只需执行：

```powershell
npx tsx .agent/skills/notes-search/scripts/src/cli.ts search -q "问题" -m hybrid -n 5
```

详见 [notes-search/SKILL.md](notes-search/SKILL.md)

## License

MIT
