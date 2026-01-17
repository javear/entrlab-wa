defmodule SocketServerWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :socket_server

  # The session will be stored in the cookie and signed,
  # this means its contents can be read but not tampered with.
  # Set :encryption_salt if you would also like to encrypt it.
  @session_options [
    store: :cookie,
    key: "_socket_server_key",
    signing_salt: "socket_server_signing"
  ]

  # Function to check origin - reads from Application config (set in runtime.exs)
  def check_origin(origin) do
    allowed_origins = Application.get_env(:socket_server, __MODULE__)[:check_origin] || []
    
    Enum.any?(allowed_origins, fn
      pattern when is_binary(pattern) -> pattern == origin
      %Regex{} = regex -> String.match?(origin, regex)
      _ -> false
    end)
  end

  socket "/socket", SocketServerWeb.UserSocket,
    websocket: true,
    longpoll: false,
    check_origin: &__MODULE__.check_origin/1

  # Serve at "/" the static files from "priv/static" directory.
  # You should set gzip to true if you are running phx.digest
  # when deploying your static files in production.
  plug Plug.Static,
    at: "/",
    from: :socket_server,
    gzip: false,
    only: ~w(assets fonts images favicon.ico robots.txt)

  # Code reloading can be explicitly enabled under the
  # :code_reloader configuration of your endpoint.
  if code_reloading? do
    plug Phoenix.CodeReloader
    plug Phoenix.Ecto.CheckRepoStatus, otp_app: :socket_server
  end

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Jason

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options

  # Health check endpoint
  plug SocketServerWeb.Router
end
