# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS dependencies

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false \
  && npm cache clean --force

FROM node:22-bookworm-slim AS engine

LABEL org.opencontainers.image.source="https://github.com/TorinMars/t-agent" \
      org.opencontainers.image.description="T-Agent remote execution Engine"

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production \
    T_AGENT_MODE=engine \
    T_AGENT_INSTALL_TYPE=docker \
    T_AGENT_DATA_DIR=/var/lib/t-agent \
    TASKS_BASE_DIR=/workspace \
    ENGINE_HOST=0.0.0.0 \
    PORT=3100

RUN mkdir -p /var/lib/t-agent /workspace

VOLUME ["/var/lib/t-agent", "/workspace"]
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const http=require('http');const req=http.get({host:'127.0.0.1',port:Number(process.env.PORT||3100),path:'/v1/health'},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.setTimeout(3000,()=>req.destroy());req.on('error',()=>process.exit(1));"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/engine/server.js"]
