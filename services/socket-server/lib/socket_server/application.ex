defmodule SocketServer.Application do
  @moduledoc false
  use Application

  @impl true
  def start(_type, _args) do
    # Validate required environment variables
    validate_config()

    children = [
      # Start the PubSub system
      {Phoenix.PubSub, name: SocketServer.PubSub},
      
      # Start the endpoint when the application starts
      SocketServerWeb.Endpoint,
      
      # Start Redis connection
      {Redix, redis_config()},
      
      # Start stream consumer
      SocketServer.Consumers.StreamConsumer
    ]

    opts = [strategy: :one_for_one, name: SocketServer.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    SocketServerWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  defp redis_config do
    config = Application.get_env(:socket_server, :redis)
    
    host = Keyword.get(config, :host, "localhost")
    port = Keyword.get(config, :port, 6379)
    password = Keyword.get(config, :password)
    database = Keyword.get(config, :database, 0)
    
    base_config = [
      host: host,
      port: port,
      database: database,
      name: :redix
    ]
    
    if password do
      Keyword.put(base_config, :password, password)
    else
      base_config
    end
  end

  defp validate_config do
    room_hash_secret = Application.get_env(:socket_server, :room_hash)[:secret]
    
    if is_nil(room_hash_secret) or room_hash_secret == "" do
      raise """
      ROOM_HASH_SECRET environment variable is required.
      Please set it to a strong random string.
      """
    end
    
    jwt_secret = Application.get_env(:socket_server, :jwt)[:secret]
    
    if is_nil(jwt_secret) or jwt_secret == "" do
      raise """
      WA_JWT_SECRET environment variable is required (JWT_SECRET is also accepted as fallback).
      Please set WA_JWT_SECRET to match your main application's JWT secret.
      """
    end
  end
end
