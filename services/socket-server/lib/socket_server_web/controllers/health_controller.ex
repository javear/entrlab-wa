defmodule SocketServerWeb.HealthController do
  use Phoenix.Controller

  def check(conn, _params) do
    json(conn, %{
      status: "ok",
      service: "socket-server",
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601()
    })
  end
end
