FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      python3 \
      python3-pip \
 && pip3 install --no-cache-dir --break-system-packages \
      "yt-dlp[default,curl-cffi]" \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.js"]
