#!/bin/sh

# Startup script for WhatsApp Official Service
# Handles environment setup and starts the service

set -e
echo "🚀 Starting WhatsApp Official Service..."

# Environment check
echo "🌍 Environment check:"
echo "  - NODE_ENV: ${NODE_ENV:-not set}"
echo "  - PORT: ${PORT:-not set}"
echo "  - WA_OFFICIAL_PORT: ${WA_OFFICIAL_PORT:-not set}"
echo "  - MONGODB_URI: ${MONGODB_URI:+SET}"
echo "  - VAULT_ADDR: ${VAULT_ADDR:+SET}"
echo "  - VAULT_TOKEN: ${VAULT_TOKEN:+SET}"

# Determine port to use (PORT takes precedence for Railway compatibility)
SERVICE_PORT=${PORT:-${WA_OFFICIAL_PORT:-3004}}
echo "  - Using port: ${SERVICE_PORT}"

echo "🚀 Starting WhatsApp Official service..."
exec dumb-init -- node services/whatsapp-official/index.js



