# ThinkPulse backend — production container image for AWS ECS
FROM node:20-slim

# ECS/ALB inject PORT; default to 8080 to match server.js fallback.
ENV NODE_ENV=production
ENV PORT=8080
# Route the JSON-store file fallback to a writable, ephemeral path. Supabase is
# the durable source of truth; this only prevents EACCES noise when the
# non-root "node" user falls back to local files before Supabase responds.
ENV THINKPULSE_DATA_DIR=/tmp/thinkpulse-data

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy only the files the server needs at runtime.
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY sql/ ./sql/
COPY data/ ./data/

# Run as the unprivileged user that the node image already provides.
USER node

EXPOSE 8080

# Container-level health check hitting the app's /health.json endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/health.json'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
