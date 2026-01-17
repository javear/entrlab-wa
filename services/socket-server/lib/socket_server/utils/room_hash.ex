defmodule SocketServer.Utils.RoomHash do
  @moduledoc """
  Utility module for hashing room IDs using HMAC-SHA256.
  
  Room IDs are hashed to prevent exposing sensitive data (phone numbers, client IDs)
  in room names while maintaining deterministic hashing (same input = same hash).
  """

  @doc """
  Hashes a room ID from agent_code, client_id, and user_identifier.
  
  Uses HMAC-SHA256 with a secret key from environment variable.
  Includes agentCode to ensure proper tenant isolation (matching Weaviate's tenant structure).
  
  ## Examples
  
      iex> RoomHash.hash_room_id("agent-a", "cs-gue", "6282121547121")
      "abc123def456..."
  
  """
  def hash_room_id(agent_code, client_id, user_identifier) 
      when is_binary(agent_code) and is_binary(client_id) and is_binary(user_identifier) do
    secret = get_secret()
    
    if is_nil(secret) or secret == "" do
      raise "ROOM_HASH_SECRET environment variable is required"
    end
    
    # Construct the input string: "agentCode:clientId:userIdentifier"
    # This ensures proper tenant isolation - different agents using the same clientId
    # and userIdentifier will have different rooms (matching Weaviate's tenant structure)
    input = "#{agent_code}:#{client_id}:#{user_identifier}"
    
    # Hash using HMAC-SHA256
    hash = :crypto.mac(:hmac, :sha256, secret, input)
    
    # Return Base64 encoded hash
    Base.encode64(hash)
  end

  def hash_room_id(_agent_code, _client_id, _user_identifier) do
    raise ArgumentError, "agent_code, client_id, and user_identifier must be strings"
  end

  @doc """
  Hashes an agent room ID from agent_code only.
  
  Uses HMAC-SHA256 with a secret key from environment variable.
  Used for agent-wide rooms that broadcast all conversation updates for that agent.
  
  ## Examples
  
      iex> RoomHash.hash_agent_room_id("agent-a")
      "xyz789abc123..."
  
  """
  def hash_agent_room_id(agent_code) when is_binary(agent_code) do
    secret = get_secret()
    
    if is_nil(secret) or secret == "" do
      raise "ROOM_HASH_SECRET environment variable is required"
    end
    
    # Construct the input string: "agentCode"
    # This creates a room for all conversations belonging to this agent
    input = agent_code
    
    # Hash using HMAC-SHA256
    hash = :crypto.mac(:hmac, :sha256, secret, input)
    
    # Return Base64 encoded hash
    Base.encode64(hash)
  end

  def hash_agent_room_id(_agent_code) do
    raise ArgumentError, "agent_code must be a string"
  end

  defp get_secret do
    Application.get_env(:socket_server, :room_hash)[:secret]
  end
end
