defmodule SocketServerWeb.Router do
  use SocketServerWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", SocketServerWeb do
    # Health check endpoint (no pipeline needed)
    get "/health", HealthController, :check
  end
end
