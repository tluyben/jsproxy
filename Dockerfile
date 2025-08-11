FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    curl \
    sqlite

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p data certs logs && \
    chown -R node:node /app

USER node

EXPOSE 80 443 8080 8443

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${HTTP_PORT:-8080}/health || exit 1

CMD ["node", "index.js"]