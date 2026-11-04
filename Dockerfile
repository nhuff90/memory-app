# syntax=docker/dockerfile:1

# Build: install everything, build the web app and server, and bake in the search model
# so the running app never needs to download anything.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Compilers in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# onnxruntime-node would otherwise download ~400 MB of GPU libraries on linux/x64.
ENV ONNXRUNTIME_NODE_INSTALL=skip
# Optional Hugging Face mirror for the model download (e.g. --build-arg HF_ENDPOINT=https://hf-mirror.example).
ARG HF_ENDPOINT=
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# After building, drop dev tools, the browser-only ONNX runtime (transformers.js bundles what it needs),
# and ONNX binaries for other platforms.
RUN npm run build \
  && RECALL_MODEL_DIR=/app/models HF_ENDPOINT="$HF_ENDPOINT" node dist/server/scripts/prefetch-model.js \
  && npm prune --omit=dev \
  && rm -rf node_modules/onnxruntime-web \
  && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 2 -maxdepth 2 ! -path "*/linux/$(node -p process.arch)" -exec rm -rf {} +

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
  PORT=8080 \
  RECALL_DATA_DIR=/data \
  RECALL_MODEL_DIR=/app/models
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/models ./models
# Off-site database backup, switched on by setting BUCKET_NAME (see litestream.yml).
COPY --from=litestream/litestream:0.5.17 /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
COPY scripts/start.sh ./scripts/start.sh
# Normalize Windows line endings even when building from an existing checkout.
RUN sed -i 's/\r$//' scripts/start.sh && sh -n scripts/start.sh
EXPOSE 8080
CMD ["sh", "scripts/start.sh"]
