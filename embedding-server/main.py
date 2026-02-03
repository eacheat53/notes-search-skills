"""
Local Embedding API Server
提供 OpenAI 兼容的 /v1/embeddings API，使用 multilingual-e5-base 模型

启动方式:
    uv run uvicorn main:app --host 0.0.0.0 --port 8000

测试:
    curl -X POST http://localhost:8000/v1/embeddings \
        -H "Content-Type: application/json" \
        -d '{"input": ["hello world"], "model": "multilingual-e5-base"}'
"""

from contextlib import asynccontextmanager
from typing import Union

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

# 全局模型实例
model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动时加载模型"""
    global model
    print("Loading multilingual-e5-base model...")
    model = SentenceTransformer("intfloat/multilingual-e5-base")
    print(f"Model loaded. Embedding dimension: {model.get_sentence_embedding_dimension()}")
    yield
    # 关闭时清理
    model = None


app = FastAPI(
    title="Local Embedding API",
    description="OpenAI-compatible embedding API using multilingual-e5-base",
    version="1.0.0",
    lifespan=lifespan,
)


# ===== Request/Response Models =====

class EmbeddingRequest(BaseModel):
    """嵌入请求格式（OpenAI 兼容）"""
    input: Union[str, list[str]]
    model: str = "multilingual-e5-base"
    # E5 模型特定选项
    input_type: str = "query"  # "query" 或 "passage"


class EmbeddingData(BaseModel):
    """单个嵌入结果"""
    object: str = "embedding"
    index: int
    embedding: list[float]


class EmbeddingUsage(BaseModel):
    """Token 使用统计"""
    prompt_tokens: int
    total_tokens: int


class EmbeddingResponse(BaseModel):
    """嵌入响应格式（OpenAI 兼容）"""
    object: str = "list"
    data: list[EmbeddingData]
    model: str
    usage: EmbeddingUsage


# ===== API Endpoints =====

@app.get("/")
async def root():
    """健康检查"""
    return {"status": "ok", "model": "multilingual-e5-base"}


@app.get("/v1/models")
async def list_models():
    """列出可用模型"""
    return {
        "object": "list",
        "data": [
            {
                "id": "multilingual-e5-base",
                "object": "model",
                "owned_by": "intfloat",
            }
        ],
    }


@app.post("/v1/embeddings", response_model=EmbeddingResponse)
async def create_embeddings(request: EmbeddingRequest):
    """
    生成文本嵌入向量
    
    E5 模型要求:
    - 查询文本添加 "query: " 前缀
    - 文档/段落添加 "passage: " 前缀
    
    通过 input_type 参数控制:
    - "query": 用于搜索查询 (默认)
    - "passage": 用于文档索引
    """
    global model
    
    # 处理输入
    if isinstance(request.input, str):
        texts = [request.input]
    else:
        texts = request.input
    
    # 添加 E5 前缀（如果没有的话）
    prefix = "query: " if request.input_type == "query" else "passage: "
    processed_texts = []
    for text in texts:
        if not text.startswith("query: ") and not text.startswith("passage: "):
            processed_texts.append(prefix + text)
        else:
            processed_texts.append(text)
    
    # 生成嵌入
    embeddings = model.encode(
        processed_texts,
        normalize_embeddings=True,  # L2 归一化
        show_progress_bar=False,
    )
    
    # 构建响应
    data = [
        EmbeddingData(
            index=i,
            embedding=embedding.tolist(),
        )
        for i, embedding in enumerate(embeddings)
    ]
    
    # 估算 token 数量（粗略）
    total_chars = sum(len(t) for t in texts)
    estimated_tokens = total_chars // 4
    
    return EmbeddingResponse(
        data=data,
        model=request.model,
        usage=EmbeddingUsage(
            prompt_tokens=estimated_tokens,
            total_tokens=estimated_tokens,
        ),
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
