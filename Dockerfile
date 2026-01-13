# Multi-stage build for TypeScript WhatsApp Bot
# Stage 1: Build stage
FROM node:18-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    xvfb \
    dbus \
    gtk+3.0 \
    libdrm \
    libxcomposite \
    libxdamage \
    libxrandr \
    mesa-gbm

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Verify Chromium installation in builder stage
RUN chromium-browser --version && \
    echo "✅ Chromium installed successfully in builder" && \
    ls -la /usr/bin/chromium*

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies for TypeScript build)
RUN npm install

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript to JavaScript
RUN npm run build

# Stage 2: Production stage
FROM node:18-alpine AS production

# Install runtime dependencies for Chromium
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dumb-init \
    su-exec \
    xvfb \
    dbus \
    gtk+3.0 \
    libdrm \
    libxcomposite \
    libxdamage \
    libxrandr \
    mesa-gbm

# Create app user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S whatsapp-bot -u 1001

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Verify Chromium installation
RUN chromium-browser --version && \
    echo "✅ Chromium installed successfully" && \
    ls -la /usr/bin/chromium*

# Set Railway-specific environment variables
ENV RAILWAY_VOLUME_PATH=/data
ENV PORT=8080

# Set working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Copy services directory (required by pubsub.controller for stream.service)
# The compiled code requires '../../services/pubsub/services/stream.service'
COPY services/ ./services/

# Copy public assets (CSS, etc.)
COPY public/ ./public/

# Copy environment file if exists
COPY .env* ./

# Copy startup script
COPY scripts/start.sh /usr/src/app/start.sh
RUN chmod +x /usr/src/app/start.sh

# Create data directory for WhatsApp session with proper permissions
RUN mkdir -p /data && \
    chown -R whatsapp-bot:nodejs /data && \
    chown -R whatsapp-bot:nodejs /usr/src/app && \
    chmod -R 777 /data


# Expose the app port (Railway uses PORT env var)
EXPOSE 8080

# Container-level healthcheck against the app's /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
    CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })" || exit 1

# Use the startup script to handle user switching
CMD ["/usr/src/app/start.sh"]
