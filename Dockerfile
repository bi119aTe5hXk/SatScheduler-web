FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend-builder
ENV CI=true
WORKDIR /frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate \
    && pnpm install --frozen-lockfile
COPY frontend/ ./
RUN pnpm run build

FROM debian:bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-pip python3-venv python3-numpy \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv --system-site-packages /opt/venv
WORKDIR /app
COPY backend/pyproject.toml ./pyproject.toml
COPY backend/app ./app
RUN pip install --no-cache-dir .
COPY --from=frontend-builder /frontend/dist ./static
RUN useradd --system --uid 10001 --home /app satscheduler \
    && mkdir -p /data \
    && chown -R satscheduler:satscheduler /app /data
USER satscheduler
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
