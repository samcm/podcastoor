FROM node:22-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY tests ./tests
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY requirements-whisperx.txt ./
RUN python3 -m venv /opt/whisperx \
  && /opt/whisperx/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/whisperx/bin/pip install --no-cache-dir -r requirements-whisperx.txt

ENV NODE_ENV=production
ENV WHISPERX_PYTHON=/opt/whisperx/bin/python
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY config.example.yaml ./

EXPOSE 3000 3729
CMD ["node", "dist/src/cli.js", "server"]
