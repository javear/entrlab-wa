# This file is responsible for configuring your application
# and its dependencies at runtime.
#
# This configuration file is loaded at runtime before any
# dependencies and is restricted to this project.

import Config

# Get allowed origins from environment variable
# Supports comma-separated list of origins
# Default: allow all Lovable and Railway preview domains using regex
allowed_origins = case System.get_env("ALLOWED_ORIGINS") do
  nil ->
    # Default: allow all Lovable and Railway preview domains
    [
      ~r/^https:\/\/.*\.lovable\.app$/,
      ~r/^https:\/\/.*\.railway\.app$/
    ]
  origins_string ->
    # Parse comma-separated list
    origins_string
    |> String.split(",")
    |> Enum.map(&String.trim/1)
end

# Configures the endpoint
config :socket_server, SocketServerWeb.Endpoint,
  http: [
    ip: {0, 0, 0, 0},
    port: String.to_integer(System.get_env("PORT") || "4000")
  ],
  url: [
    host: System.get_env("PHOENIX_HOST") || System.get_env("RAILWAY_PUBLIC_DOMAIN") || "localhost",
    port: 443,
    scheme: "https"
  ],
  secret_key_base: System.get_env("SECRET_KEY_BASE") || "temporary-secret-key-base-change-in-production",
  server: true,
  check_origin: allowed_origins

# Redis/Valkey configuration
# Support both URL format (redis://user:pass@host:port) and separate env vars
redis_url = System.get_env("VALKEY_HOST") || System.get_env("REDIS_HOST") || System.get_env("VALKEY_URL") || System.get_env("REDIS_URL")

{redis_host, redis_port, redis_password} = if redis_url && String.starts_with?(redis_url, "redis://") do
  # Parse Redis URL: redis://user:password@host:port
  uri = URI.parse(redis_url)
  host = uri.host || "localhost"
  port = if uri.port, do: uri.port, else: 6379
  password = if uri.userinfo do
    # Extract password from userinfo (format: "user:password" or just "password")
    parts = String.split(uri.userinfo, ":")
    if length(parts) > 1, do: Enum.at(parts, 1), else: Enum.at(parts, 0)
  else
    nil
  end
  {host, port, password}
else
  # Use separate env vars or defaults
  host = redis_url || "localhost"
  port = String.to_integer(System.get_env("VALKEY_PORT") || System.get_env("REDIS_PORT") || "6379")
  password = System.get_env("VALKEY_PASSWORD") || System.get_env("REDIS_PASSWORD")
  {host, port, password}
end

config :socket_server, :redis,
  host: redis_host,
  port: redis_port,
  password: redis_password,
  database: String.to_integer(System.get_env("VALKEY_DB") || System.get_env("REDIS_DB") || "0")

# Stream configuration
# Default stream name matches the producer's default: "whatsapp:events"
config :socket_server, :stream,
  stream_name: System.get_env("VALKEY_STREAM_NAME") || "whatsapp:events",
  consumer_group: System.get_env("SOCKET_CONSUMER_GROUP") || "socket-server-consumer",
  consumer_name: System.get_env("SOCKET_CONSUMER_NAME") || "socket-server-consumer-1",
  start_id: System.get_env("SOCKET_CONSUMER_START_ID") || "$"

# JWT configuration
# WA_JWT_SECRET is the single source of truth for JWT secret
config :socket_server, :jwt,
  secret: System.get_env("WA_JWT_SECRET") || System.get_env("JWT_SECRET")

# Room hash configuration
config :socket_server, :room_hash,
  secret: System.get_env("ROOM_HASH_SECRET")
