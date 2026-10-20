FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# SQLite database lives on a volume, owned by the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=3000 \
    DB_PATH=/data/notes.db
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
