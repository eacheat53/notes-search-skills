---
name: notes-search
description: |
  搜索用户个人 Markdown 笔记/知识库，支持词法和语义搜索。
  
  触发条件：
  (1) 用户提问涉及"我的笔记"、"根据笔记"、"in my vault"
  (2) 需要从个人文档中检索信息
  (3) 基于知识库回答问题
---

# Notes Search CLI

搜索用户 Obsidian Vault 中的 Markdown 笔记，返回相关内容供回答问题。

## 执行命令

```powershell
# 启动本地嵌入服务
cd /your/path/to/embedding-server; uv run uvicorn main:app --port 8000

# 搜索笔记（在工作区目录下执行）
npx tsx .agent/skills/notes-search/scripts/src/cli.ts search -q "用户问题" -m hybrid -n 5
```

## 参数

| 参数 | 说明 |
|------|------|
| `-q "..."` | 搜索查询（必填） |
| `-m lexical` | 词法搜索：精确关键词、人名、标签 |
| `-m semantic` | 语义搜索：概念性问题 |
| `-m hybrid` | 混合搜索（推荐） |
| `-n 5` | 返回结果数 |

## 错误处理

- `fetch failed` → 本地嵌入服务未启动，用 `-m lexical` 替代

## 输出

返回 JSON，`results` 数组包含：`title`, `content`, `score`, `path`
