FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY bindery ./bindery

RUN uv sync --frozen --no-dev

COPY templates ./templates
COPY static ./static
COPY rules ./rules
COPY themes ./themes

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /data/library \
    && chown -R app:app /app /data/library

ENV BINDERY_LIBRARY_DIR=/data/library

USER app

EXPOSE 5670
VOLUME ["/data/library"]

CMD ["uv", "run", "uvicorn", "bindery.web:app", "--host", "0.0.0.0", "--port", "5670"]
