#!/bin/bash

# Startup script for Socket Server (Elixir Phoenix)
# Loads environment variables from .env and starts the service

echo "🚀 Starting Socket Server (Elixir Phoenix)..."

# Get the script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

# Load environment variables from .env file if it exists
if [ -f "$ENV_FILE" ]; then
  echo "📝 Loading environment variables from .env..."
  # Use set -a to automatically export all variables
  set -a
  # Source the .env file, but filter out comments, empty lines, and invalid lines
  # Only include lines that match the pattern KEY=VALUE (with optional quotes)
  TEMP_ENV=$(mktemp)
  # Filter: remove comments, empty lines, and lines that don't look like KEY=VALUE
  grep -v '^#' "$ENV_FILE" | \
    grep -v '^[[:space:]]*$' | \
    grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' > "$TEMP_ENV" || true
  # Only source if we have valid lines
  if [ -s "$TEMP_ENV" ]; then
    set -a
    source "$TEMP_ENV" 2>/dev/null || true
    set +a
  fi
  rm -f "$TEMP_ENV"
  set +a
  echo "✅ Environment variables loaded"
else
  echo "⚠️  .env file not found at $ENV_FILE"
  echo "   Make sure required environment variables are set:"
  echo "   - WA_JWT_SECRET (JWT_SECRET also accepted as fallback)"
  echo "   - ROOM_HASH_SECRET"
  echo "   - VALKEY_HOST (optional, defaults to localhost)"
  echo "   - VALKEY_PORT (optional, defaults to 6379)"
fi

# Environment check
echo "🌍 Environment check:"
echo "  - WA_JWT_SECRET: ${WA_JWT_SECRET:+SET}${JWT_SECRET:+SET (using JWT_SECRET as fallback)}"
echo "  - ROOM_HASH_SECRET: ${ROOM_HASH_SECRET:+SET}"
echo "  - VALKEY_HOST: ${VALKEY_HOST:-${REDIS_HOST:-localhost}}"
echo "  - VALKEY_PORT: ${VALKEY_PORT:-${REDIS_PORT:-6379}}"
echo "  - PORT: ${PORT:-${SOCKET_PORT:-4000}}"

# Change to socket-server directory
cd "$PROJECT_ROOT/services/socket-server"

# Start the Phoenix server
echo "🚀 Starting Phoenix server..."
exec mix phx.server
