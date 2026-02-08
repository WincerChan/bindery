FROM python:3.12-slim

# 保持你的环境变量配置
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# 安装基础工具（这一步没问题）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 uv（保持原样，或者用 COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv 更快）
RUN pip install --no-cache-dir uv

WORKDIR /app

# --- 🚀 优化开始 ---

# 1. 先只拷贝依赖定义文件
COPY pyproject.toml uv.lock ./

# 2. 安装依赖，但不安装项目本身 (--no-install-project)
# 这样只要 lock 文件不变，这一层就会被 Docker 完美缓存，构建速度秒级。
RUN uv sync --frozen --no-dev --no-install-project

# 3. 把 .venv/bin 加入 PATH
# 这一步是关键！这样做之后，你就可以直接运行 uvicorn 了，不需要 uv run
ENV PATH="/app/.venv/bin:$PATH"

# 4. 现在才拷贝源代码
COPY bindery ./bindery
COPY README.md ./

# 5. 最后安装项目本身 (如果有必要的话，比如 bindery 是一个包)
# 如果 bindery 不是安装包，这一步甚至可以省略，取决于你的 import 方式
RUN uv sync --frozen --no-dev

# --- 优化结束 ---

COPY templates ./templates
COPY static ./static
COPY bindery-templates ./bindery-templates

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /data/library /data/templates \
    && chown -R app:app /app /data

ENV BINDERY_LIBRARY_DIR=/data/library \
    BINDERY_TEMPLATE_DIR=/data/templates

USER app

EXPOSE 5670
VOLUME ["/data"]

CMD ["uvicorn", "bindery.web:app", "--host", "0.0.0.0", "--port", "5670", "--proxy-headers"]