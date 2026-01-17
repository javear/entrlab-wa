defmodule SocketServerWeb.UserSocket do
  use Phoenix.Socket

  ## Channels
  channel "conversation", SocketServerWeb.ConversationChannel
  channel "agent", SocketServerWeb.AgentChannel

  ## Transports
  # WebSocket transport is configured in endpoint
  # transport :longpoll, Phoenix.Transports.LongPoll

  @doc """
  Socket-level JWT authentication.
  
  Accepts JWT token via:
  - Query parameter: `?token=JWT_TOKEN`
  - Connection params: `socket.connect({token: "JWT_TOKEN"})`
  
  Validates JWT and extracts agentCode, storing it in socket assigns.
  """
  def connect(params, socket, _connect_info) do
    require Logger
    
    # Get token from params (query param or connection params)
    token = Map.get(params, "token") || Map.get(params, :token)
    
    if is_nil(token) do
      Logger.warning("Socket connection refused: missing token")
      {:error, %{reason: "missing_token"}}
    else
      case validate_jwt(token) do
        {:ok, claims} ->
          agent_code = extract_agent_code(claims)
          
          if is_nil(agent_code) do
            Logger.warning("Socket connection refused: missing agentCode in JWT claims")
            {:error, %{reason: "missing_agent_code"}}
          else
            Logger.info("Socket connection accepted for agent: #{agent_code}")
            sender_info = extract_sender_info(claims, agent_code)
            socket = 
              socket
              |> assign(:agent_code, agent_code)
              |> assign(:user_id, Map.get(claims, "sub") || Map.get(claims, :sub))
              |> assign(:sender_info, sender_info)
            
            {:ok, socket}
          end
        
        {:error, reason} ->
          Logger.warning("Socket connection refused: JWT validation failed - #{inspect(reason)}")
          {:error, %{reason: reason}}
      end
    end
  end

  def id(socket), do: "user_socket:#{socket.assigns.user_id}"

  defp validate_jwt(token) do
    require Logger
    
    secret = Application.get_env(:socket_server, :jwt)[:secret]
    
    if is_nil(secret) or secret == "" do
      Logger.error("JWT secret not configured")
      {:error, "jwt_secret_not_configured"}
    else
      try do
        # Create HS256 signer
        signer = Joken.Signer.create("HS256", secret)
        
        # Create a Joken config with default claims validation
        # Joken 2.6: Use default_claims() which includes exp, iat, nbf validation
        config = Joken.Config.default_claims()
        
        # Verify and validate the token
        # Joken 2.6: verify_and_validate takes (config, token, signer)
        case Joken.verify_and_validate(config, token, signer) do
          {:ok, claims} -> 
            Logger.debug("JWT verified successfully for agent: #{inspect(Map.get(claims, "agentCode") || Map.get(claims, :agentCode))}")
            {:ok, claims}
          {:error, reason} -> 
            Logger.warning("JWT verification failed: #{inspect(reason)}")
            {:error, "invalid_token: #{inspect(reason)}"}
        end
      rescue
        e -> 
          Logger.error("JWT verification exception: #{inspect(e)}")
          {:error, "jwt_verification_error: #{inspect(e)}"}
      end
    end
  end

  defp extract_agent_code(claims) do
    # Try different possible field names for agentCode
    Map.get(claims, "agentCode") ||
    Map.get(claims, :agentCode) ||
    Map.get(claims, "agent_code") ||
    Map.get(claims, :agent_code) ||
    get_in(claims, ["agent_metadata", "agent_code"]) ||
    get_in(claims, [:agent_metadata, :agent_code])
  end

  defp extract_sender_info(claims, agent_code) do
    # Extract sender object from JWT claims (similar to REST API)
    sender = Map.get(claims, "sender") || Map.get(claims, :sender) || %{}
    
    # Build sender info with fallback logic (matches chat.controller.ts lines 341-351)
    %{
      senderId: get_sender_field(sender, ["senderId", "id"]) || agent_code || "system",
      senderDisplayName: get_sender_field(sender, ["senderDisplayName", "displayName", "name"]),
      senderRoleLabel: get_sender_field(sender, ["senderRoleLabel", "roleLabel"]) || "agent",
      senderAvatarUrl: get_sender_field(sender, ["senderAvatarUrl", "avatarUrl"])
    }
  end

  defp get_sender_field(sender, keys) when is_map(sender) do
    Enum.reduce_while(keys, nil, fn key, _acc ->
      value = Map.get(sender, key) || Map.get(sender, String.to_atom(key))
      if value, do: {:halt, value}, else: {:cont, nil}
    end)
  end

  defp get_sender_field(_sender, _keys), do: nil
end
