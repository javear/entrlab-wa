defmodule SocketServer.Consumers.StreamConsumer do
  @moduledoc """
  GenServer that consumes messages from Redis Streams and broadcasts them
  to Phoenix channels.
  
  Follows best practices: reads pending messages first, then new messages.
  """
  use GenServer
  require Logger

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def init(_state) do
    # Get configuration
    stream_config = Application.get_env(:socket_server, :stream)
    stream_name = Keyword.get(stream_config, :stream_name, "whatsapp:events")
    consumer_group = Keyword.get(stream_config, :consumer_group, "socket-server-consumer")
    consumer_name = Keyword.get(stream_config, :consumer_name, "socket-server-consumer-1")
    start_id = Keyword.get(stream_config, :start_id, "$")
    
    Logger.info("Stream consumer initializing...")
    Logger.info("  Stream: #{stream_name}")
    Logger.info("  Consumer Group: #{consumer_group}")
    Logger.info("  Consumer Name: #{consumer_name}")
    Logger.info("  Start ID: #{start_id}")
    
    # Wait a bit for Redis to be ready
    Process.send_after(self(), :init_consumer, 2000)
    
    state = %{
      conn: nil,
      stream_name: stream_name,
      consumer_group: consumer_group,
      consumer_name: consumer_name,
      start_id: start_id,
      is_running: false
    }
    
    {:ok, state}
  end

  def handle_info(:init_consumer, state) do
    # Get Redis connection
    case Process.whereis(:redix) do
      nil ->
        Logger.warning("Redis connection not found, retrying in 5 seconds...")
        Logger.info("Make sure Redis/Valkey is running and accessible")
        Process.send_after(self(), :init_consumer, 5000)
        {:noreply, state}
      
      conn ->
        # Test the connection first
        case test_redis_connection(conn) do
          :ok ->
            Logger.info("Redis connection established, initializing consumer...")
            # Ensure consumer group exists
            ensure_consumer_group(conn, state.stream_name, state.consumer_group, state.start_id)
            
            # Start consuming
            Logger.info("✅ Consumer initialized successfully, starting to consume messages...")
            Process.send_after(self(), :consume, 1000)
            
            new_state = %{state | conn: conn, is_running: true}
            {:noreply, new_state}
          
          {:error, reason} ->
            Logger.warning("Redis connection test failed: #{inspect(reason)}, retrying in 5 seconds...")
            Process.send_after(self(), :init_consumer, 5000)
            {:noreply, state}
        end
    end
  end

  def handle_info({:DOWN, _ref, :process, _pid, reason}, state) do
    Logger.error("Redis connection lost: #{inspect(reason)}")
    {:noreply, state}
  end

  def handle_info(:consume, state) do
    cond do
      state.is_running && state.conn ->
        # Test connection before consuming
        case test_redis_connection(state.conn) do
          :ok ->
            consume_messages(state)
            # Schedule next consumption
            _ref = Process.send_after(self(), :consume, 100)
            {:noreply, state}
          
          {:error, _reason} ->
            # Connection lost, reinitialize
            Logger.warning("Redis connection lost, reinitializing...")
            new_state = %{state | is_running: false, conn: nil}
            _ref = Process.send_after(self(), :init_consumer, 2000)
            {:noreply, new_state}
        end
      
      not state.is_running ->
        # Retry initialization if not running
        _ref = Process.send_after(self(), :init_consumer, 5000)
        {:noreply, state}
      
      true ->
        # Schedule next consumption even if conn is nil (will retry init)
        _ref = Process.send_after(self(), :consume, 2000)
        {:noreply, state}
    end
  end

  defp test_redis_connection(conn) do
    try do
      case Redix.command(conn, ["PING"]) do
        {:ok, "PONG"} -> :ok
        {:ok, _} -> :ok
        {:error, reason} -> {:error, reason}
      end
    rescue
      e -> {:error, e}
    end
  end

  defp consume_messages(state) do
    if is_nil(state.conn) do
      # Connection not ready, skip this cycle
      :ok
    else
      try do
        # Step 1: Read pending messages first (non-blocking)
        pending_entries = read_pending_messages(state)
        
        entries = if length(pending_entries) > 0 do
          Logger.debug("Found #{length(pending_entries)} pending message(s)")
          pending_entries
        else
          # Step 2: Read new messages (blocking with short timeout)
          read_new_messages(state)
        end
        
        # Process entries
        if length(entries) > 0 do
          Logger.debug("Processing #{length(entries)} message(s)")
        end
        
        for entry <- entries do
          process_entry(entry, state)
        end
      rescue
        e ->
          Logger.error("Error consuming messages: #{inspect(e)}")
      end
    end
  end

  defp read_pending_messages(state) do
    if is_nil(state.conn) do
      []
    else
      try do
        # Read pending messages (id: '0')
        case Redix.command(state.conn, [
          "XREADGROUP", "GROUP", state.consumer_group, state.consumer_name,
          "COUNT", "10",
          "BLOCK", "0",  # Non-blocking
          "STREAMS", state.stream_name, "0"
        ]) do
          {:ok, nil} -> []
          {:ok, [[_stream, entries]]} -> parse_entries(entries)
          {:error, %Redix.ConnectionError{reason: :closed}} ->
            # Connection closed, will be handled by consume loop
            []
          {:error, reason} ->
            # Only log non-connection errors to reduce noise
            Logger.debug("Error reading pending messages: #{inspect(reason)}")
            []
        end
      rescue
        e ->
          Logger.error("Exception reading pending messages: #{inspect(e)}")
          []
      end
    end
  end

  defp read_new_messages(state) do
    if is_nil(state.conn) do
      []
    else
      try do
        # Read new messages (id: '>')
        case Redix.command(state.conn, [
          "XREADGROUP", "GROUP", state.consumer_group, state.consumer_name,
          "COUNT", "10",
          "BLOCK", "1000",  # Block for 1 second
          "STREAMS", state.stream_name, ">"
        ]) do
          {:ok, nil} -> []
          {:ok, [[_stream, entries]]} -> parse_entries(entries)
          {:error, %Redix.ConnectionError{reason: :closed}} ->
            # Connection closed, will be handled by consume loop
            []
          {:error, reason} ->
            # Only log non-connection errors to reduce noise
            Logger.debug("Error reading new messages: #{inspect(reason)}")
            []
        end
      rescue
        e ->
          Logger.error("Exception reading new messages: #{inspect(e)}")
          []
      end
    end
  end

  defp parse_entries(entries) do
    Enum.map(entries, fn [entry_id, fields] ->
      # Parse fields into a map
      raw_data = Enum.chunk_every(fields, 2)
        |> Enum.map(fn [key, value] -> {key, value} end)
        |> Enum.into(%{})
      
      # Parse JSON strings in the data
      # Some fields might be JSON strings that need to be decoded
      data = parse_json_fields(raw_data)
      
      %{id: entry_id, data: data}
    end)
  end

  defp parse_json_fields(data) do
    Enum.reduce(data, %{}, fn {key, value}, acc ->
      # Try to parse JSON strings, keep original if not JSON
      parsed_value = cond do
        is_binary(value) && String.starts_with?(String.trim(value), "{") ->
          # Looks like JSON, try to parse
          case Jason.decode(value) do
            {:ok, decoded} -> decoded
            {:error, _} -> value
          end
        is_binary(value) && String.starts_with?(String.trim(value), "[") ->
          # Looks like JSON array, try to parse
          case Jason.decode(value) do
            {:ok, decoded} -> decoded
            {:error, _} -> value
          end
        true ->
          value
      end
      
      Map.put(acc, key, parsed_value)
    end)
  end

  defp process_entry(%{id: entry_id, data: data}, state) do
    try do
      # Parse event data - data should now be properly parsed
      event_type = safe_get(data, "eventType") || safe_get(data, "event_type")
      
      # Skip message:outgoing events (internal routing events)
      if event_type == "message:outgoing" do
        # ACK and skip
        acknowledge_message(state, entry_id)
      else
        # Filter for events we care about
        if event_type in ["message:incoming", "ai:response", "agent:response"] do
          # Extract agentCode, clientId, userIdentifier, and hashedId (pre-calculated by producer)
          agent_code = safe_get(data, "agentCode") || safe_get(data, "agent_code")
          client_id = safe_get(data, "clientId") || safe_get(data, "client_id")
          user_identifier = safe_get(data, "userIdentifier") || safe_get(data, "user_identifier")
          hashed_id = safe_get(data, "hashedId") || safe_get(data, "hashed_id")
          
          if agent_code && client_id && user_identifier do
            # Use pre-calculated hashed_id from producer, or calculate it if missing (backward compatibility)
            conversation_hashed_id = if hashed_id do
              hashed_id
            else
              # Fallback: calculate if not provided (for backward compatibility with old events)
              SocketServer.Utils.RoomHash.hash_room_id(agent_code, client_id, user_identifier)
            end
            
            conversation_room_topic = "conversation:#{conversation_hashed_id}"
            
            # Format event payload for conversation room (full payload)
            conversation_payload = format_event_payload(entry_id, event_type, data)
            
            # Extract clientMessageId for logging (check both :client_message_id and "clientMessageId" keys)
            client_message_id_log = Map.get(conversation_payload, :client_message_id) || Map.get(conversation_payload, "client_message_id")
            client_message_id_log_str = if client_message_id_log, do: ", clientMessageId: #{client_message_id_log}", else: ""
            
            # Broadcast to conversation-specific room using pre-hashed ID
            Phoenix.PubSub.broadcast(SocketServer.PubSub, conversation_room_topic, {:new_message, conversation_payload})
            
            Logger.info("📨 Broadcasted #{event_type} to conversation room #{conversation_room_topic} (agentCode: #{agent_code}, clientId: #{client_id}, userIdentifier: #{user_identifier}, hashedId: #{conversation_hashed_id}#{client_message_id_log_str})")
            
            # Also broadcast to agent-wide room for conversation list updates
            # This allows the UI to update the conversation list in real-time
            agent_hashed_id = SocketServer.Utils.RoomHash.hash_agent_room_id(agent_code)
            agent_room_topic = "agent:#{agent_hashed_id}"
            
            # Format minimal payload for agent room (just enough for UI refresh)
            agent_payload = format_agent_update_payload(entry_id, event_type, data, client_id, user_identifier, conversation_hashed_id)
            
            # Extract clientMessageId for logging (check both :client_message_id and "clientMessageId" keys)
            client_message_id_log = Map.get(agent_payload, :client_message_id) || Map.get(agent_payload, "client_message_id")
            client_message_id_log_str = if client_message_id_log, do: ", clientMessageId: #{client_message_id_log}", else: ""
            
            # Broadcast to agent-wide room
            Phoenix.PubSub.broadcast(SocketServer.PubSub, agent_room_topic, {:conversation_update, agent_payload})
            
            Logger.info("📢 Broadcasted conversation update to agent room #{agent_room_topic} (agentCode: #{agent_code}#{client_message_id_log_str})")
          else
            Logger.warning("Missing agentCode, clientId, or userIdentifier in event #{entry_id}")
          end
        end
        
        # Acknowledge message
        acknowledge_message(state, entry_id)
      end
    rescue
      e ->
        Logger.error("Error processing entry #{entry_id}: #{inspect(e)}")
        # Don't ACK on error - will retry
    end
  end

  defp format_event_payload(entry_id, event_type, data) do
    # Extract sender info
    sender = extract_sender_info(data, event_type)
    
    # Extract content
    content = extract_content(data, event_type)
    
    # Extract clientId and userIdentifier for conversation_id
    client_id = safe_get(data, "clientId") || safe_get(data, "client_id")
    user_identifier = safe_get(data, "userIdentifier") || safe_get(data, "user_identifier")
    conversation_id = if client_id && user_identifier, do: "#{client_id}:#{user_identifier}", else: nil
    
    # Extract messageType, mediaUrl, and caption from stream data (for media messages)
    message_type = safe_get(data, "messageType") || safe_get(data, "message_type") || "text"
    
    # For outgoing messages (agent sends): mediaUrl and caption are at top level
    # For incoming messages (user sends): mediaUrls (array) is in metadata.message.mediaUrls, caption is in content
    media_url = safe_get(data, "mediaUrl") || safe_get(data, "media_url")
    caption = safe_get(data, "caption")
    
    # Extract clientMessageId from metadata (for idempotency - allows client to match optimistic updates)
    metadata = safe_get(data, "metadata") || %{}
    # Try both string and atom keys, and also check if metadata is a string that needs parsing
    metadata = case metadata do
      m when is_map(m) -> m
      s when is_binary(s) -> 
        case Jason.decode(s) do
          {:ok, decoded} -> decoded
          {:error, _} -> %{}
        end
      _ -> %{}
    end
    # Try both camelCase and snake_case keys
    client_message_id = Map.get(metadata, "clientMessageId") || 
                        Map.get(metadata, :clientMessageId) || 
                        Map.get(metadata, "client_message_id") || 
                        Map.get(metadata, :client_message_id)
    
    # If mediaUrl not found at top level, check metadata for incoming messages
    # Incoming messages store mediaUrls as an array in metadata.message.mediaUrls
    media_url = if is_nil(media_url) do
      message_meta = safe_get(metadata, "message") || %{}
      media_urls_array = safe_get(message_meta, "mediaUrls") || safe_get(message_meta, "media_urls") || []
      
      # Use first media URL if available (incoming messages typically have one media file)
      if is_list(media_urls_array) and length(media_urls_array) > 0 do
        List.first(media_urls_array)
      else
        nil
      end
    else
      media_url
    end
    
    payload = %{
      event_id: entry_id,
      event_type: event_type,
      content: content,
      message_type: message_type, # Include messageType for media message support
      sender: sender,
      timestamp: safe_get(data, "timestamp") || DateTime.utc_now() |> DateTime.to_iso8601(),
      conversation_id: conversation_id,
      client_message_id: client_message_id # Include clientMessageId for idempotency matching
    }
    
    # Add mediaUrl and caption if present (for media messages)
    payload = if media_url do
      Map.put(payload, :media_url, media_url)
    else
      payload
    end
    
    payload = if caption do
      Map.put(payload, :caption, caption)
    else
      payload
    end
    
    payload
  end

  defp extract_sender_info(data, event_type) do
    case event_type do
      "ai:response" ->
        agent_code = safe_get(data, "agentCode") || safe_get(data, "agent_code")
        %{
          type: "ai:agent",
          id: agent_code || "unknown",
          displayName: agent_code || "AI Agent",
          roleLabel: "assistant",
          avatarUrl: nil
        }
      
      "agent:response" ->
        metadata = safe_get(data, "metadata") || %{}
        sender_meta = safe_get(metadata, "sender") || %{}
        
        %{
          type: "agent",
          id: safe_get(sender_meta, "senderId") || safe_get(sender_meta, "id") || safe_get(data, "agentCode") || "unknown",
          displayName: safe_get(sender_meta, "senderDisplayName") || safe_get(sender_meta, "displayName") || safe_get(data, "agentCode") || "Agent",
          roleLabel: safe_get(sender_meta, "senderRoleLabel") || safe_get(sender_meta, "roleLabel") || "agent",
          avatarUrl: safe_get(sender_meta, "senderAvatarUrl") || safe_get(sender_meta, "avatarUrl")
        }
      
      "message:incoming" ->
        metadata = safe_get(data, "metadata") || %{}
        sender_meta = safe_get(metadata, "sender") || %{}
        user_identifier = safe_get(data, "userIdentifier") || safe_get(data, "user_identifier")
        
        %{
          type: "user",
          id: user_identifier || "unknown",
          displayName: safe_get(sender_meta, "name") || safe_get(sender_meta, "pushname") || safe_get(sender_meta, "formattedName"),
          roleLabel: "user",
          avatarUrl: safe_get(sender_meta, "profilePicUrl") || safe_get(sender_meta, "avatarUrl")
        }
      
      _ ->
        %{
          type: "unknown",
          id: "unknown",
          displayName: nil,
          roleLabel: nil,
          avatarUrl: nil
        }
    end
  end

  defp format_agent_update_payload(entry_id, event_type, data, client_id, user_identifier, hashed_id) do
    # Payload for agent room - includes content for conversation list preview
    # conversation_id is now hashed_id (universal ID across services)
    # This makes it consistent with the API which uses hashed_id as conversationId
    
    # Extract content for conversation list preview
    content = extract_content(data, event_type)
    
    # Extract sender info for display
    sender = extract_sender_info(data, event_type)
    
    # Extract messageType, mediaUrl, and caption from stream data (for media messages)
    message_type = safe_get(data, "messageType") || safe_get(data, "message_type") || "text"
    
    # For outgoing messages (agent sends): mediaUrl and caption are at top level
    # For incoming messages (user sends): mediaUrls (array) is in metadata.message.mediaUrls, caption is in content
    media_url = safe_get(data, "mediaUrl") || safe_get(data, "media_url")
    caption = safe_get(data, "caption")
    
    # Extract clientMessageId from metadata (for idempotency - allows client to match optimistic updates)
    metadata = safe_get(data, "metadata") || %{}
    # Try both string and atom keys, and also check if metadata is a string that needs parsing
    metadata = case metadata do
      m when is_map(m) -> m
      s when is_binary(s) -> 
        case Jason.decode(s) do
          {:ok, decoded} -> decoded
          {:error, _} -> %{}
        end
      _ -> %{}
    end
    # Try both camelCase and snake_case keys
    client_message_id = Map.get(metadata, "clientMessageId") || 
                        Map.get(metadata, :clientMessageId) || 
                        Map.get(metadata, "client_message_id") || 
                        Map.get(metadata, :client_message_id)
    
    # If mediaUrl not found at top level, check metadata for incoming messages
    # Incoming messages store mediaUrls as an array in metadata.message.mediaUrls
    media_url = if is_nil(media_url) do
      message_meta = safe_get(metadata, "message") || %{}
      media_urls_array = safe_get(message_meta, "mediaUrls") || safe_get(message_meta, "media_urls") || []
      
      # Use first media URL if available (incoming messages typically have one media file)
      if is_list(media_urls_array) and length(media_urls_array) > 0 do
        List.first(media_urls_array)
      else
        nil
      end
    else
      media_url
    end
    
    payload = %{
      event_id: entry_id,
      event_type: event_type,
      conversation_id: hashed_id, # Use hashed_id as conversation_id (universal ID across services)
      client_id: client_id,
      user_identifier: user_identifier,
      hashed_id: hashed_id, # Keep hashed_id for backward compatibility
      content: content, # Message content for conversation list preview
      message_type: message_type, # Include messageType for media message support
      sender: sender, # Sender info for display
      timestamp: safe_get(data, "timestamp") || DateTime.utc_now() |> DateTime.to_iso8601(),
      client_message_id: client_message_id # Include clientMessageId for idempotency matching
    }
    
    # Add mediaUrl and caption if present (for media messages)
    payload = if media_url do
      Map.put(payload, :media_url, media_url)
    else
      payload
    end
    
    payload = if caption do
      Map.put(payload, :caption, caption)
    else
      payload
    end
    
    payload
  end

  # Helper to safely get values from maps, handling JSON strings
  defp safe_get(data, key) when is_map(data) do
    case Map.get(data, key) do
      nil -> nil
      value when is_binary(value) ->
        # Try to parse if it looks like JSON
        if String.starts_with?(String.trim(value), "{") || String.starts_with?(String.trim(value), "[") do
          case Jason.decode(value) do
            {:ok, decoded} -> decoded
            {:error, _} -> value
          end
        else
          value
        end
      value -> value
    end
  end

  defp safe_get(_, _), do: nil

  defp extract_content(data, event_type) do
    case event_type do
      "ai:response" ->
        extract_response_content(data, "response")
      
      "agent:response" ->
        extract_response_content(data, "response") || 
        extract_fallback_content(data)
      
      "message:incoming" ->
        # Check if this is a media message
        message_type = safe_get(data, "messageType") || safe_get(data, "message_type") || "text"
        media_types = ["image", "video", "audio", "file", "document", "sticker"]
        is_media_type = message_type in media_types
        
        # Extract mediaUrl from metadata.message.mediaUrls (for incoming) or top-level (for outgoing)
        media_url = safe_get(data, "mediaUrl") || safe_get(data, "media_url")
        
        # If not found at top level, check metadata for incoming messages
        media_url = if is_nil(media_url) and is_media_type do
          metadata = safe_get(data, "metadata") || %{}
          metadata = case metadata do
            m when is_map(m) -> m
            s when is_binary(s) -> 
              case Jason.decode(s) do
                {:ok, decoded} -> decoded
                {:error, _} -> %{}
              end
            _ -> %{}
          end
          message_meta = safe_get(metadata, "message") || %{}
          media_urls_array = safe_get(message_meta, "mediaUrls") || safe_get(message_meta, "media_urls") || []
          if is_list(media_urls_array) and length(media_urls_array) > 0 do
            List.first(media_urls_array)
          else
            nil
          end
        else
          media_url
        end
        
        content = safe_get(data, "content") || "" # Caption for media, text for regular messages
        
        if is_media_type and media_url do
          # Format as media message
          message_obj = %{type: message_type, url: media_url}
          # Add caption if available
          message_obj = if content && content != "" do
            Map.put(message_obj, :caption, to_string(content))
          else
            message_obj
          end
          Jason.encode!([message_obj])
        else
          # Format as text message
          Jason.encode!([%{type: "text", text: to_string(content)}])
        end
      
      _ ->
        Jason.encode!([])
    end
  end

  defp extract_response_content(data, key) do
    response = safe_get(data, key) || %{}
    messages = safe_get(response, "messages")
    
    if is_list(messages) do
      Jason.encode!(messages)
    else
      formatted = safe_get(response, "formatted") || %{}
      whatsapp = safe_get(formatted, "whatsapp")
      
      if is_list(whatsapp) do
        Jason.encode!(whatsapp)
      else
        nil
      end
    end
  end

  defp extract_fallback_content(data) do
    content = safe_get(data, "content")
    message_type = safe_get(data, "messageType") || safe_get(data, "message_type") || "text"
    media_types = ["image", "video", "audio", "file", "document", "sticker"]
    is_media_type = message_type in media_types
    media_url = safe_get(data, "mediaUrl") || safe_get(data, "media_url")
    caption = safe_get(data, "caption")
    
    cond do
      is_media_type && media_url ->
        # Format as media message
        message_obj = %{type: message_type, url: media_url}
        # Add caption if available (prefer explicit caption, fallback to content)
        message_obj = cond do
          caption && caption != "" ->
            Map.put(message_obj, :caption, to_string(caption))
          content && content != "" ->
            Map.put(message_obj, :caption, to_string(content))
          true ->
            message_obj
        end
        Jason.encode!([message_obj])
      
      content ->
        # Format as text message
        Jason.encode!([%{type: message_type, text: to_string(content)}])
      
      true ->
        Jason.encode!([])
    end
  end

  defp acknowledge_message(state, entry_id) do
    if is_nil(state.conn) do
      Logger.warning("Cannot acknowledge message #{entry_id}: Redis connection not available")
    else
      try do
        case Redix.command(state.conn, [
          "XACK", state.stream_name, state.consumer_group, entry_id
        ]) do
          {:ok, _} -> :ok
          {:error, reason} ->
            Logger.error("Error acknowledging message #{entry_id}: #{inspect(reason)}")
        end
      rescue
        e ->
          Logger.error("Exception acknowledging message #{entry_id}: #{inspect(e)}")
      end
    end
  end

  defp ensure_consumer_group(conn, stream_name, group_name, start_id) do
    if is_nil(conn) do
      Logger.warning("Cannot create consumer group: Redis connection not available")
    else
      try do
        # Try to create consumer group
        case Redix.command(conn, [
          "XGROUP", "CREATE", stream_name, group_name, start_id,
          "MKSTREAM"
        ]) do
          {:ok, "OK"} ->
            Logger.info("✅ Created consumer group '#{group_name}' on stream '#{stream_name}' starting from '#{start_id}'")
          
          {:error, %Redix.Error{message: message}} ->
            # Group might already exist, that's OK
            if String.contains?(message, "BUSYGROUP") do
              Logger.info("ℹ️  Consumer group '#{group_name}' already exists on stream '#{stream_name}'")
            else
              Logger.warning("⚠️  Error creating consumer group: #{message}")
            end
          
          other ->
            Logger.debug("Consumer group creation result: #{inspect(other)}")
        end
      rescue
        e ->
          Logger.error("❌ Exception creating consumer group: #{inspect(e)}")
      end
    end
  end
end
