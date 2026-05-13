"""
Local Embedding & Reranking API Server
提供 OpenAI 兼容的 /v1/embeddings API + /v1/rerank API

模型：
- Embedding: intfloat/multilingual-e5-base (bi-encoder, 快速召回)
- Reranking: BAAI/bge-reranker-v2-m3 (cross-encoder, 精确重排)

启动方式:
    uv run uvicorn main:app --host 0.0.0.0 --port 8000
"""

from contextlib import asynccontextmanager
from typing import Union

from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer, CrossEncoder

# 全局模型实例
embed_model: SentenceTransformer | None = None
rerank_model: CrossEncoder | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动时加载模型"""
    global embed_model, rerank_model

    print("Loading multilingual-e5-base (embedding)...")
    embed_model = SentenceTransformer("intfloat/multilingual-e5-base")
    print(f"Embedding model loaded. Dimension: {embed_model.get_sentence_embedding_dimension()}")

    print("Loading bge-reranker-v2-m3 (reranking)...")
    rerank_model = CrossEncoder("BAAI/bge-reranker-v2-m3")
    print("Reranking model loaded.")

    yield

    embed_model = None
    rerank_model = None


app = FastAPI(
    title="Local Embedding & Reranking API",
    description="OpenAI-compatible embedding API + Reranking API",
    version="2.0.0",
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


class RerankDocument(BaseModel):
    """重排文档"""
    id: str = ""
    text: str


class RerankRequest(BaseModel):
    """重排请求"""
    query: str
    documents: list[Union[str, RerankDocument]]
    top_n: int | None = None
    model: str = "bge-reranker-v2-m3"


class RerankResult(BaseModel):
    """单个重排结果"""
    index: int
    relevance_score: float
    document: dict


class RerankResponse(BaseModel):
    """重排响应"""
    results: list[RerankResult]
    model: str


# ===== API Endpoints =====

@app.get("/")
async def root():
    """健康检查"""
    return {
        "status": "ok",
        "models": {
            "embedding": "multilingual-e5-base",
            "reranking": "bge-reranker-v2-m3",
        },
    }


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
                "type": "embedding",
            },
            {
                "id": "bge-reranker-v2-m3",
                "object": "model",
                "owned_by": "BAAI",
                "type": "reranking",
            },
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
    global embed_model
    
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
    embeddings = embed_model.encode(
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


@app.post("/v1/rerank", response_model=RerankResponse)
async def rerank_documents(request: RerankRequest):
    """
    使用 Cross-Encoder 对文档进行精确重排
    
    Cross-Encoder 将 query+document 一起送入模型，
    比 bi-encoder (embedding) 的相似度计算更精确，
    但速度更慢，适合对少量候选结果进行精排。
    
    典型用法：先用 embedding 召回 top-20，再用 rerank 精排出 top-5。
    """
    global rerank_model

    # 解析文档
    texts: list[str] = []
    doc_ids: list[str] = []
    for i, doc in enumerate(request.documents):
        if isinstance(doc, str):
            texts.append(doc)
            doc_ids.append(str(i))
        else:
            texts.append(doc.text)
            doc_ids.append(doc.id or str(i))

    # 构建 query-document 对
    pairs = [[request.query, text] for text in texts]

    # Cross-Encoder 打分
    scores = rerank_model.predict(pairs, show_progress_bar=False)

    # 构建结果并按分数排序
    results = []
    for i, score in enumerate(scores):
        results.append(
            RerankResult(
                index=i,
                relevance_score=float(score),
                document={"id": doc_ids[i], "text": texts[i][:200]},
            )
        )

    results.sort(key=lambda r: r.relevance_score, reverse=True)

    # 截取 top_n
    if request.top_n is not None:
        results = results[: request.top_n]

    return RerankResponse(
        results=results,
        model=request.model,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
