defmodule SocketServer.Publishers.StreamPublisher do
  @moduledoc """
  Publisher module for publishing messages to Redis Streams.
  
  This module handles publishing outgoing messages to the Redis stream,
  similar to the Node.js StreamProducer.
  """

  require Logger

  @doc """
  Publishes an outgoing message to the Redis stream.
  
  ## Parameters
  
  - `agent_code` - Agent code from JWT
  - `client_id` - Client ID (from socket assigns)
  - `user_identifier` - User identifier (from socket assigns)
  - `content` - Message content
  - `message_type` - Message type (default: "text")
  - `sender_info` - Sender information map (from JWT)
  - `platform` - Platform type: "wpp" or "wa-official" (default: "wpp")
  - `client_message_id` - Optional client message ID for idempotency (allows client to match optimistic updates)
  
  ## Returns
  
  - `{:ok, entry_id}` - Success with stream entry ID
  - `{:error, reason}` - Error reason
  
  ## Example
  
      iex> StreamPublisher.publish_outgoing_message(
      ...>   "agent-a",
      ...>   "client-1",
      ...>   "6282121547121",
      ...>   "Hello!",
      ...>   "text",
      ...>   %{senderId: "agent-123", senderDisplayName: "John Doe"},
      ...>   "wpp",
      ...>   "client-msg-123"
      ...> )
      {:ok, "1768543834709-0"}
  """
  def publish_outgoing_message(agent_code, client_id, user_identifier, content, message_type \\ "text", sender_info \\ %{}, platform \\ "wpp", client_message_id \\ nil) do
    # Get Redis connection
    case Process.whereis(:redix) do
      nil ->
        Logger.error("Redis connection not found")
        {:error, :redis_not_connected}
      
      conn ->
        try do
          # Calculate hashedId using RoomHash (matches Node.js producer)
          hashed_id = SocketServer.Utils.RoomHash.hash_room_id(agent_code, client_id, user_identifier)
          
          # Generate message ID (UUID v4)
          message_id = generate_message_id()
          
          # Get stream name from config
          stream_name = Application.get_env(:socket_server, :stream)[:stream_name] || "whatsapp:events"
          
          # Build entry data (matches Node.js producer format)
          # Use provided platform (defaults to "wpp" if not specified)
          # Platform should be "wpp" or "wa-official"
          entry_data = %{
            "eventType" => "message:outgoing",
            "timestamp" => DateTime.utc_now() |> DateTime.to_iso8601(),
            "agentCode" => agent_code,
            "clientId" => client_id,
            "platform" => platform, # Use provided platform ("wpp" or "wa-official")
            "userIdentifier" => user_identifier,
            "messageId" => message_id,
            "messageType" => message_type || "text",
            "content" => content,
            "hashedId" => hashed_id,
            "metadata" => build_metadata(agent_code, sender_info, hashed_id, client_message_id)
          }
          
          # Prepare stream entry (convert to string format for Redis)
          stream_entry = prepare_stream_entry(entry_data)
          
          # Publish to stream using XADD
          case Redix.command(conn, ["XADD", stream_name, "*" | stream_entry]) do
            {:ok, entry_id} ->
              Logger.info("📤 Published outgoing message to stream: #{entry_id} (conversationId: #{hashed_id}, agentCode: #{agent_code})")
              {:ok, entry_id}
            
            {:error, reason} ->
              Logger.error("❌ Failed to publish outgoing message: #{inspect(reason)}")
              {:error, reason}
          end
        rescue
          e ->
            Logger.error("❌ Exception publishing outgoing message: #{inspect(e)}")
            {:error, Exception.message(e)}
        end
    end
  end

  # Prepare stream entry for Redis XADD command
  # Converts map to flat list of key-value pairs (all values as strings)
  defp prepare_stream_entry(data) do
    Enum.reduce(data, [], fn {key, value}, acc ->
      string_key = to_string(key)
      string_value = case value do
        nil -> ""
        v when is_binary(v) -> v
        v when is_map(v) -> Jason.encode!(v)
        v -> to_string(v)
      end
      acc ++ [string_key, string_value]
    end)
  end

  # Generate message ID (matches REST API format: "socket-{timestamp}-{random}")
  defp generate_message_id do
    timestamp = System.system_time(:millisecond)
    random = :crypto.strong_rand_bytes(4) |> Base.encode16(case: :lower) |> String.slice(0, 7)
    "socket-#{timestamp}-#{random}"
  end

  # Build metadata map with optional clientMessageId for idempotency
  defp build_metadata(agent_code, sender_info, hashed_id, client_message_id) do
    metadata = %{
      "source" => "socket",
      "postedBy" => Map.get(sender_info, :senderId) || agent_code || "system",
      "sender" => %{
        "senderId" => Map.get(sender_info, :senderId) || agent_code || "system",
        "senderDisplayName" => Map.get(sender_info, :senderDisplayName),
        "senderRoleLabel" => Map.get(sender_info, :senderRoleLabel) || "agent",
        "senderAvatarUrl" => Map.get(sender_info, :senderAvatarUrl)
      },
      "conversationId" => hashed_id,
      "timestamp" => DateTime.utc_now() |> DateTime.to_iso8601()
    }

    # Add clientMessageId if provided (for client idempotency matching)
    metadata = if client_message_id do
      Map.put(metadata, "clientMessageId", client_message_id)
    else
      metadata
    end

    Jason.encode!(metadata)
  end
end
